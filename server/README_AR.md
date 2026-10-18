# تشغيل GamesPlot مع MySQL

## 1) جهّز ملف البيئة
داخل مجلد `server` انسخ `.env.example` إلى ملف اسمه `.env`.
إذا MySQL عندك على WampServer بالإعداد الافتراضي غالباً لا تحتاج إلا:

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=gamesplot
```

إذا حساب root عنده كلمة مرور، اكتبها في `DB_PASSWORD` داخل `.env` فقط. لا ترفع `.env` إلى GitHub.

## 2) ثبّت الحزم وشغّل السيرفر
افتح PowerShell أو CMD داخل مجلد `server`:

```bash
npm install
npm start
```

ثم افتح:

`http://localhost:3000/api/health`

المفروض يظهر `{"ok":true,"database":"connected"}`.
بعدها افتح الموقع نفسه من:

`http://localhost:3000`

WampServer مطلوب لتشغيل MySQL، أما صفحات الموقع والـ API فيشغلها Node.js على المنفذ 3000.

## 3) نقل بيانات Firestore القديمة إلى MySQL (مرة واحدة فقط)
إذا عندك مستخدمون/أسئلة/تعليقات قديمة في Firestore وتريد الاحتفاظ بها:

1. Firebase Console > Project settings > Service accounts > Generate new private key.
2. احفظ الملف داخل `server` باسم `serviceAccountKey.json`.
3. لا ترفعه إلى GitHub ولا ترسله لأي شخص.
4. شغّل:

```bash
npm run migrate:firestore
```

السكريبت ينقل users/categories/questions/comments/notifications/suggestions/reports/active_radar ويحافظ على Firebase UID للمستخدمين.
عدادات likes/dislikes القديمة تنتقل، لكن اختيار كل مستخدم لصوته القديم لا يمكن نقله لأن النسخة القديمة كانت تحفظ اختيار التصويت داخل localStorage في متصفح المستخدم.

إذا سبق ونقلت البيانات وتريد إعادة النقل من الصفر، اجعل `MIGRATION_CLEAR_SQL=true` في `.env` مؤقتاً. هذا يمسح بيانات جداول GamesPlot في MySQL قبل الاستيراد، لذلك لا تستخدمه إلا وأنت متأكد.

## 4) Firebase Auth
تسجيل الدخول ما زال Firebase Authentication. بيانات الموقع نفسها أصبحت عبر API إلى MySQL.
الـ API يتحقق من Firebase ID Token مع Firebase قبل السماح بالطلبات.

## 5) النشر لاحقاً
Firebase Hosting وحده لا يشغّل Node.js/MySQL. عند النشر النهائي سنضع مجلد `server` على استضافة Backend (أو Cloud Run/VPS ونحوها) ونغيّر `API_BASE` في `api-firestore.js` إلى رابط الـ API الحقيقي.
