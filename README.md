# GROW-CONNECTION: הגדרות סליקה עבור VIBE CODING ו-BASE44

מאגר זה מכיל את הגדרות החיבור והסליקה עבור מערכת GROW, המותאמות לעבודה עם תשתית BASE44 ו-VIBE CODING.

## ספק סליקה: HYP (Yaad Sarig)

החיבור מתבצע מול ממשק ה-API של HYP (יעד שריג) לצורך יצירת דפי תשלום מאובטחים.

### משתני סביבה נדרשים (Environment Variables)

לצורך הפעלת הפונקציה ב-Supabase/BASE44, יש להגדיר את המשתנים הבאים:

1. `HYPAY_API_KEY`: המפתח שנוצר בממשק הניהול של HYP (Security -> API Keys).
2. `YAAD_PASSP`: סיסמת ה-API של המסוף הספציפי.
3. `YAAD_MASOF`: מספר המסוף (Masof) - לרוב 7 ספרות.

### מיפוי נתונים ל-BASE44

הפונקציה `createPaymentLink` מצפה למבנה הנתונים הבא:

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
const { paymentUrl } = await base44.functions.invoke('createPaymentLink', {
  body: {
    orderId: 'ORD-123',
    totalAmount: 150.00,
    customerName: 'ישראל ישראלי',
    customerEmail: 'customer@example.com'
  }
});

// הפנייה לדף התשלום
window.location.href = paymentUrl;
```

---
**נכתב עבור VIBE CODING & BASE44**
