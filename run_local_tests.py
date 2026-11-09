#!/usr/bin/env python3
"""Browser smoke/integration tests against the isolated in-memory Supabase mock."""
from http.server import ThreadingHTTPServer
import threading

from playwright.sync_api import sync_playwright
from local_test_server import Handler

PORT = 0
server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
base = f'http://127.0.0.1:{server.server_address[1]}'
results = []
page_errors = []
production_requests = []


def check(name, fn):
    fn()
    results.append(name)
    print('PASS:', name)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox', '--disable-dev-shm-usage'])
        page = browser.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=1)
        page.on('pageerror', lambda error: page_errors.append(str(error) + ('\n' + error.stack if getattr(error, 'stack', None) else '')))
        page.on('request', lambda request: production_requests.append(request.url) if 'vslyxdkyozhmyazvrpdj.supabase.co' in request.url else None)
        response = page.goto(base + '/__test__/index.html', wait_until='domcontentloaded', timeout=30000)
        if response is None or response.status != 200:
            raise AssertionError(f'test page returned {response.status if response else "no response"}')
        page.wait_for_selector('#auth-container', state='visible', timeout=10000)
        page.wait_for_timeout(400)

        if page.title() != 'VURQENA':
            raise AssertionError(f'wrong branded document title: {page.title()}')
        if page.locator('link[rel="stylesheet"][href="/vurqena-brand.css"]').count() != 1:
            raise AssertionError('VURQENA brand stylesheet is not linked exactly once')
        page.wait_for_function("Array.from(document.querySelectorAll('img.logo-img')).length === 2 && Array.from(document.querySelectorAll('img.logo-img')).every(i => i.complete && i.naturalWidth > 0)", timeout=5000)
        token = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--vurqena-teal').trim().toLowerCase()")
        if token != '#245b60':
            raise AssertionError(f'brand CSS token missing: {token}')
        check('تحميل عنوان VURQENA وملف الهوية والرمز المعتمد', lambda: None)

        check('واجهة تسجيل الدخول تعرض في شاشة الهاتف', lambda: page.locator('#login-form').is_visible())
        check('النموذج لا يفرض منع تكبير الصفحة', lambda: page.locator('meta[name="viewport"]').get_attribute('content') == 'width=device-width, initial-scale=1.0')

        page.evaluate('toggleAuthMode(true)')
        check('التبديل إلى نموذج إنشاء الحساب', lambda: page.locator('#register-form').is_visible())
        page.locator('#reg-name').fill('اختبار محلي')
        page.locator('#reg-username').fill('local_test')
        page.locator('#reg-email').fill('local@example.invalid')
        page.locator('#reg-pass').fill('local-test-password')
        page.locator('#register-form button.btn').click()
        page.wait_for_selector('#email-verify-overlay', state='visible', timeout=10000)
        check('التسجيل التجريبي يعرض مسار تأكيد البريد', lambda: page.locator('#email-verify-overlay').get_by_text('local@example.invalid').is_visible())
        page.locator('#resend-verification-btn').click()
        page.wait_for_function("window.__PHOENIX_LOCAL_TEST__.calls.some(c => c.method === 'auth.resend')", timeout=5000)
        check('إعادة إرسال التفعيل تصل إلى المحاكي المحلي', lambda: page.locator('#email-verify-overlay').get_by_text('تم إرسال رسالة تفعيل جديدة. تحقق من البريد ومجلد Spam.').is_visible())

        value = page.evaluate("""async () => {
          await window.PhoenixSupabase.db.ref('local_test/probe').set({message:'hello', count:2});
          const snap = await window.PhoenixSupabase.db.ref('local_test/probe').once('value');
          return {value:snap.val(), calls:window.__PHOENIX_LOCAL_TEST__.calls.map(c=>c.method==='rpc'?c.name:c.method)};
        }""")
        if value['value'] != {'message': 'hello', 'count': 2}:
            raise AssertionError(f'adapter read/write mismatch: {value}')
        check('Supabase compatibility adapter set/get عبر RPC محلي وهمي', lambda: None)

        page.locator('#email-verify-overlay button').last.click()
        page.locator('#login-email').fill('local@example.invalid')
        page.locator('#login-pass').fill('local-test-password')
        page.locator('#login-form button.btn').click()
        page.wait_for_function("!document.getElementById('main-app').classList.contains('hidden')", timeout=10000)
        check('تسجيل الدخول الوهمي يفتح واجهة التطبيق', lambda: page.locator('#page-home').is_visible())
        page.wait_for_function('window.isAdmin === true', timeout=5000)
        if 'hidden' in (page.locator('#home-admin-btn').get_attribute('class') or ''):
            raise AssertionError('admin home control stayed hidden for an admin account')
        check('تحميل دور Admin يُظهر أدوات الإدارة داخل Phoenix', lambda: None)
        if page.locator('#page-home h1').inner_text().strip() != 'VURQENA':
            raise AssertionError('home wordmark did not change to VURQENA')
        check('تظهر العلامة النصية VURQENA في الصفحة الرئيسية', lambda: None)
        page.evaluate('toggleTheme()')
        light_bg = page.evaluate("getComputedStyle(document.body).getPropertyValue('--bg').trim().toLowerCase()")
        if light_bg != '#f5f2ea':
            raise AssertionError(f'light theme token mismatch: {light_bg}')
        page.evaluate('toggleTheme()')
        dark_bg = page.evaluate("getComputedStyle(document.body).getPropertyValue('--bg').trim().toLowerCase()")
        if dark_bg != '#142638':
            raise AssertionError(f'dark theme token mismatch: {dark_bg}')
        check('تبديل الوضع الفاتح والداكن يحتفظ بلوحة VURQENA', lambda: None)
        verified = page.evaluate("""() => new Promise(resolve => {
          const timer = setTimeout(() => resolve(false), 3000);
          window.verifyAdminThen(() => { clearTimeout(timer); resolve(true); });
        })""")
        if not verified:
            raise AssertionError('server-backed admin guard did not authorize the test user')
        check('حارس العمليات الإدارية يتحقق من admins/<uid>', lambda: None)
        page.locator('#nav-search').click()
        page.wait_for_function("!document.getElementById('page-search').classList.contains('hidden')", timeout=5000)
        check('التنقل الفعلي إلى البحث بعد الدخول', lambda: page.locator('#nav-search').get_attribute('class').find('active') >= 0)
        page.wait_for_timeout(800)

        calls = page.evaluate('window.__PHOENIX_LOCAL_TEST__.calls')
        if not any(c.get('method') == 'createClient' and c.get('url') == 'http://supabase-mock.local' for c in calls):
            raise AssertionError('Supabase client was not created against the local mock')
        check('اتصال Supabase موجّه للمحاكي المحلي فقط', lambda: None)
        if production_requests:
            raise AssertionError(f'production Supabase requests were made: {production_requests}')
        check('لا توجد طلبات شبكية إلى Supabase الإنتاجي', lambda: None)

        dims = page.evaluate('({viewport:document.documentElement.clientWidth, content:document.documentElement.scrollWidth})')
        if dims['content'] > dims['viewport'] + 1:
            raise AssertionError(f'horizontal overflow at 390px: {dims}')
        check('لا يوجد تجاوز أفقي عند عرض 390px', lambda: None)

        page.evaluate("showPage('page-search','nav-search')")
        if 'hidden' in (page.locator('#page-search').get_attribute('class') or ''):
            raise AssertionError('showPage did not display the requested page')
        if 'hidden' not in (page.locator('#page-home').get_attribute('class') or ''):
            raise AssertionError('showPage did not hide the previous page')
        if 'active' not in (page.locator('#nav-search').get_attribute('class') or ''):
            raise AssertionError('showPage did not update active navigation')
        check('showPage يبدّل الصفحة ويحدّث حالة التنقل', lambda: None)

        page.evaluate("showPage('page-home','nav-home')")
        responsive = []
        for width, height in [(375, 812), (768, 1024), (1280, 800)]:
            page.set_viewport_size({'width': width, 'height': height})
            page.wait_for_timeout(80)
            dims = page.evaluate('({viewport:document.documentElement.clientWidth, content:document.documentElement.scrollWidth})')
            responsive.append((width, dims['viewport'], dims['content']))
            if dims['content'] > dims['viewport'] + 1:
                offenders = page.evaluate("""() => ({widths:{inner:innerWidth,client:document.documentElement.clientWidth,body:document.body.scrollWidth,doc:document.documentElement.scrollWidth},elements:[...document.querySelectorAll('body *')].map(el => {
                  const r=el.getBoundingClientRect(), s=getComputedStyle(el);
                  return {tag:el.tagName,id:el.id,cls:String(el.className||'').slice(0,80),left:Math.round(r.left),right:Math.round(r.right),display:s.display};
                }).filter(x => x.right > document.documentElement.clientWidth + 1 && x.right - x.left > 0 && x.display !== 'none').slice(0,20),overflowing:[...document.querySelectorAll('body *')].filter(el=>el.scrollWidth>el.clientWidth+1 && el.clientWidth>0).slice(0,30).map(el=>({tag:el.tagName,id:el.id,cls:String(el.className||'').slice(0,80),scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,overflow:getComputedStyle(el).overflow})),children:[...document.body.children].map(el=>({tag:el.tagName,id:el.id,cls:String(el.className||'').slice(0,60),left:Math.round(el.getBoundingClientRect().left),right:Math.round(el.getBoundingClientRect().right),width:Math.round(el.getBoundingClientRect().width),scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,position:getComputedStyle(el).position,overflow:getComputedStyle(el).overflow}))})""")
                raise AssertionError(f'horizontal overflow at {width}px: {dims}; elements={offenders}')
        check('تخطيط الصفحة الرئيسية بلا تجاوز أفقي عند 375/768/1280px', lambda: None)

        all_pages = page.locator('.page').evaluate_all('(nodes) => nodes.map(node => node.id)')
        page_overflows = []
        for width, height in [(375, 812), (768, 1024), (1280, 800)]:
            page.set_viewport_size({'width': width, 'height': height})
            for page_id in all_pages:
                page.evaluate('(id) => showPage(id)', page_id)
                page.wait_for_timeout(20)
                dims = page.evaluate('({viewport:document.documentElement.clientWidth, content:document.documentElement.scrollWidth})')
                if dims['content'] > dims['viewport'] + 1:
                    page_overflows.append((width, page_id, dims))
        if page_overflows:
            raise AssertionError(f'page overflow detected: {page_overflows[:10]}')
        check('جميع الشاشات الـ23 بلا تجاوز أفقي عند 375/768/1280px', lambda: None)

        if page_errors:
            raise AssertionError('browser runtime errors: ' + ' | '.join(page_errors))
        check('لا توجد استثناءات JavaScript غير معالجة أثناء تدفقات الاختبار', lambda: None)
        browser.close()
finally:
    server.shutdown()
    server.server_close()

print(f'\n{len(results)} local browser tests passed.')
print('Scope note: these tests validate the UI and adapter contract against an in-memory mock; they do not validate Supabase Auth, PostgreSQL/RLS, Storage, Realtime, email delivery, or the production project.')
