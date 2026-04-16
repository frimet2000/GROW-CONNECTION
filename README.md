# GROW-CONNECTION: Connector Blueprint for BASE44

 זהו מאגר הגדרות מלא (Connector Blueprint) המיועד ל-BASE44. הוא כולל את ההגדרות הטכניות והקוד הנדרש כדי לחבר את פרויקט ה-Vibe שלך ל-Grow (משולם).

 ## מה יש במאגר?

 1. **`vibe-connector.json`**: הגדרת הקונקטור בפורמט ש-BASE44 מבין אוטומטית.
 2. **`functions/`**: קוד ה-Edge Function המוכן לביצוע התשלום.
 3. **`vibe-billing.json`**: מיפוי משתנים ופרטי התקשרות.

 החיבור מתבצע מול ה-Endpoint החדש של משולם ליצירת דפי תשלום מהירים.

 ### משתני סביבה נדרשים (Environment Variables)

 לצורך הפעלת הפונקציות ב-BASE44, יש להגדיר:

 1. `GROW_PAGE_CODE`: קוד הדף (מהמערכת של משולם).
 2. `GROW_USER_ID`: מזהה המשתמש (userId).

 ### מיפוי נתונים ו-Endpoints

 **יצירת תשלום (Light API):**
 - **URL:** `https://api.meshulam.co.il/api/light/createPaymentPage`
 - **מתודה:** `POST`
 - **שדות חובה:** `userId`, `pageCode`, `sum`, `description`.

 **בדיקת סטטוס:**
 - **URL:** `https://api.meshulam.co.il/api/light/server/1.0/getPaymentProcessInfo`
 - **מתודה:** `POST` (באמצעות FormData)

 ### דוגמת קריאה מה-Frontend (BASE44 SDK)

 ```javascript
 const { url } = await base44.functions.invoke('createGrowPayment', {
   body: {
     amount: 150,
     description: 'הצטרפות לקבוצה',
     travelerName: 'ישראל ישראלי',
     travelerPhone: '0501234567'
   }
 });

 // העברה לדף התשלום שחזר ממשולם
 if (url) window.location.href = url;
 ```

 ---
 **סנכרון מול Groupy-Loopy הושלם.**
