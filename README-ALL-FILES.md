# VURQENA — فهرس التسليم

- `deploy/` — الحزمة الجاهزة للرفع إلى InfinityFree: `index.html`, `vurqena-brand.css`, `supabase-compat.js`, `sitemap.xml`, `robots.txt`, و`assets/vurqena-mark-a.png` مع تعليمات النشر.
- `source/` — نسخة المصدر والاختبارات والتقارير إذا احتجت أرشفة المشروع كاملاً. لا ترفع اختبارات المحاكي إلى الإنتاج.
- `brand-spec.md` — مواصفات الهوية والألوان والمكونات والعقود المحمية.
- `vurqena-brand.css` و`assets/vurqena-mark-a.png` — مصدر الهوية الجديد والرمز المعتمد.

حزمة النشر لا تغيّر إعدادات Supabase ولا تحتوي Service Role key. اختبارات الواجهة تستخدم محاكياً محلياً، ولا تثبت تلقائياً أداء المشروع على بيئة الإنتاج.
