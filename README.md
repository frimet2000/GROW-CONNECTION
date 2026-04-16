# GROW-CONNECTION: הגדרות סליקה עבור VIBE CODING ו-BASE44

 מאגר זה מכיל את הגדרות החיבור והסליקה עבור מערכת GROW, המותאמות לעבודה עם תשתית BASE44 ו-VIBE CODING.

 ## ספק סליקה: GROW (Meshulam)

 החיבור מתבצע מול ממשק ה-API של Grow (משולם לשעבר) לצורך יצירת תהליכי תשלום מאובטחים.

 ### משתני סביבה נדרשים (Environment Variables)

 לצורך הפעלת הפונקציה ב-Supabase/BASE44, יש להגדיר את המשתנים הבאים:

 1. `GROW_PAGE_CODE`: קוד הדף הייחודי שהונפק עבורכם במערכת Grow.
 2. `GROW_USER_ID`: מזהה המשתמש (Merchant ID) שלכם ב-Grow.
 3. `GROW_API_KEY`: (אופציונלי) מפתח ה-API לביצוע פעולות מתקדמות שרת-לשרת.

 ### מיפוי נתונים ל-BASE44

 הפונקציה `createGrowPaymentLink` מצפה למבנה הנתונים הבא:

 | שדה | סוג | מיפוי מ-BASE44 |
 | :--- | :--- | :--- |
 | `orderId` | String | מזהה ההזמנה (Unique ID) |
 | `totalAmount` | Number | סכום כולל לתשלום (ILS) |
 | `customerEmail` | String | אימייל הלקוח |
 | `customerName` | String | שם מלא של הלקוח |
 | `customerPhone` | String | טלפון הלקוח |

 ### שימוש בקוד

 ניתן לקרוא לפונקציית הסליקה באמצעות ה-SDK של BASE44:

 ```javascript
 const { paymentUrl } = await base44.functions.invoke('createGrowPaymentLink', {
   body: {
     orderId: 'ORD-123',
     totalAmount: 150.00,
     customerName: 'ישראל ישראלי',
     customerEmail: 'customer@example.com'
   }
 });

 // הפנייה לדף התשלום (Redirect)
 window.location.href = paymentUrl;
 ```

 ---
 **נכתב עבור VIBE CODING & BASE44**
