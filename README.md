# GROW-CONNECTION — Connector Blueprint for BASE44

חיבור ל-GROW (משולם) עבור פרויקטי BASE44, דרך ה-Light API.

גרסה 2.0 נכתבה מחדש על בסיס אינטגרציה חיה ובדוקה (פרויקט Orbar) שרצה מול GROW
בפועל, כולל תיקונים שהתקבלו מתמיכת ה-API של GROW. ראה [CHANGES.md](CHANGES.md)
לרשימת מה שהיה שגוי בגרסה 1 ולמה.

## מה יש במאגר

| קובץ | תפקיד |
|---|---|
| `functions/_shared/grow.ts` | לוגיקה משותפת: קונפיג, כתובות לפי סביבה, בניית בקשה, פענוח webhook, אימות שולח, approveTransaction |
| `functions/create-grow-payment/` | יצירת דף תשלום (CreatePaymentLink) |
| `functions/grow-webhook/` | קבלת ה-callback מ-GROW וסגירת ההזמנה |
| `functions/check-grow-status/` | בדיקת סטטוס יזומה מול GROW (התאמה כשה-callback לא הגיע) |
| `vibe-connector.json` | הגדרת הקונקטור ל-BASE44 |
| `vibe-billing.json` | מיפוי שדות, כתובות, והערות שדה-אמת |

## משתני סביבה

**חובה:**

| משתנה | תיאור |
|---|---|
| `GROW_USER_ID` | מזהה המשתמש (userId) |
| `GROW_PAGE_CODE` | קוד הדף (pageCode) |
| `GROW_API_KEY` | נשלח בכותרת `x-api-key`. **חובה** מאז עדכון השרת של GROW (08/2026) |

**אופציונלי:**

| משתנה | ברירת מחדל | תיאור |
|---|---|---|
| `GROW_ENVIRONMENT` | `sandbox` | `production` בלבד מעביר לכתובות החיות |
| `GROW_EXPECTED_TERMINAL` | — | **חובה בפרודקשן.** קוד המסוף שהונפק לעסק |
| `GROW_VAT_TYPE` | `1` | 1 = מע״מ רגיל, 3 = פטור |
| `GROW_NOTIFY_URL` | `<origin>/grow-webhook` | הכתובת אליה GROW שולח את ה-callback |
| `GROW_SUCCESS_URL` | — | הפניה אחרי תשלום כשהקורא לא מעביר `successUrl` |
| `GROW_WEBHOOK_KEY` | — | סוד משותף בפורמטים שכן שולחים `webhookKey` |
| `GROW_WEBHOOK_IPS` | רשימת GROW | דריסה של רשימת ה-IP המורשים |
| `GROW_DISABLE_IP_CHECK` | — | `1` מכבה אימות שולח. **פיתוח בלבד** |
| `GROW_BASE_URL` | — | דריסת ה-host אם GROW הנפיק כתובת אחרת |
| `ALLOWED_ORIGIN` | — | ה-origin היחיד שרשאי לקרוא ל-create-grow-payment |

## שדות נדרשים בישות Order

```
payment_idempotency_key   string    נוצר לכל ניסיון, נשלח כ-cField1, לפיו מאותר ה-callback
payment_amount_agorot     number    אגורות שלמות — הסכום שמולו נבדק ה-webhook
payment_id                string    processId, ואחרי סגירה — אסמכתת העסקה
payment_process_token     string    processToken, ל-getPaymentProcessInfo
payment_url               string    כתובת דף התשלום
payment_failure_reason    string
payment_card_last4        string
payment_auth_number       string
paid_at                   datetime
status                    pending_payment | completed | payment_failed | payment_review
```

## קריאה מה-Frontend

הלקוח מעביר `orderId` בלבד. הסכום נקרא בצד השרת מתוך ההזמנה — **אסור** שהדפדפן
יקבע כמה לחייב.

```javascript
const { url } = await base44.functions.invoke('create-grow-payment', {
  body: {
    orderId: order.id,
    successUrl: `${window.location.origin}/payment-success?order=${order.id}`
  }
});

if (url) window.location.href = url;
```

## כללי הזהב של האינטגרציה

1. **FormData בכל קריאה.** JSON לא מחזיר שגיאת content-type — השדות פשוט לא
   נקראים, ו-GROW עונה שגיאה מטעה (בדרך כלל "userId is required").
2. **HTTP 200 אינו הצלחה.** ה-Light API מחזיר 200 גם בכישלון; מה שקובע הוא
   `status` בגוף התשובה (1 = הצלחה).
3. **אף פעם לא לסמוך על ה-callback לבדו.** מאמתים שולח (רשימת IP), מאתרים לפי
   `cField1` שאנחנו יצרנו, ומשווים סכום מול מה שנרשם.
4. **סוגרים פעם אחת.** GROW חוזר על callbacks; סגירה חוזרת מחייבת פעמיים.
5. **`approveTransaction` אחרי כל תשלום מוצלח** — נדרש, אך best-effort: העסקה
   מעובדת גם אם הקריאה נכשלה, ולכן היא לא חוסמת סגירה.
6. **אגורות שלמות.** המרה לשקלים קורית רק על החוט.
7. **`GROW_EXPECTED_TERMINAL` לפני מעבר לפרודקשן.** מסוף בדיקה מדווח הצלחה על
   כל חיוב ולא גובה שקל.

## פריסה

```bash
supabase functions deploy create-grow-payment
supabase functions deploy grow-webhook --no-verify-jwt
supabase functions deploy check-grow-status
```

`grow-webhook` נפרס עם `--no-verify-jwt` כי GROW קורא לו ללא טוקן; האימות שלו
הוא רשימת ה-IP.

לאחר מכן יש לרשום ב-GROW את כתובת ה-webhook, ולוודא שהיא זהה ל-`GROW_NOTIFY_URL`.
