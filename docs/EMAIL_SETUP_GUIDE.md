# Email Configuration Guide

## Current Status

The email service is currently in **demo mode** - it logs emails to console instead of sending them. This is why you didn't receive an email after booking.

## How to Enable Real Email Sending

To enable actual email sending, configure the SMTP settings as backend environment variables. On Kubera these go in the secret store for the credential-bearing values (`EMAIL_SMTP_USER`, `EMAIL_SMTP_PASS`), with the non-secret values (`EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_FROM`, `EMAIL_FROM_NAME`) either in the secret store alongside them or in `.kubera/playground-backend.yaml` `config.data`.

### Option 1: Gmail SMTP (Recommended for Testing)

1. **Enable 2-Factor Authentication** on your Gmail account
2. **Generate an App Password**:
   - Go to: https://myaccount.google.com/apppasswords
   - Select "Mail" and "Other (Custom name)"
   - Enter "AdaptaLabs" as the name
   - Copy the generated 16-character password

3. **Set the environment variables** (Kubera secret store for the backend):

```
EMAIL_SMTP_HOST=smtp.gmail.com
EMAIL_SMTP_PORT=587
EMAIL_SMTP_USER=your-email@gmail.com
EMAIL_SMTP_PASS=your-app-password-here
EMAIL_FROM=noreply@adaptalabs.com
EMAIL_FROM_NAME=Adaptalabs Impact Lab
```

4. **Redeploy** so the backend pod picks up the new values (push to trigger a pipeline, or restart the pod)

### Option 2: SendGrid (Recommended for Production)

1. **Create a SendGrid account**: https://sendgrid.com
2. **Create an API Key**:
   - Go to Settings → API Keys
   - Create a new API key with "Mail Send" permissions
   - Copy the API key

3. **Set the environment variables** (Kubera secret store for the backend):
```
EMAIL_SMTP_HOST=smtp.sendgrid.net
EMAIL_SMTP_PORT=587
EMAIL_SMTP_USER=apikey
EMAIL_SMTP_PASS=your-sendgrid-api-key-here
EMAIL_FROM=noreply@adaptalabs.com
EMAIL_FROM_NAME=Adaptalabs Impact Lab
```

4. **Redeploy** so the backend pod picks up the new values (push to trigger a pipeline, or restart the pod)

### Option 3: AWS SES (For Production Scale)

1. **Set up AWS SES** in your AWS account
2. **Get SMTP credentials** from AWS SES console
3. **Set the environment variables** (Kubera secret store for the backend):
```
EMAIL_SMTP_HOST=email-smtp.us-east-1.amazonaws.com
EMAIL_SMTP_PORT=587
EMAIL_SMTP_USER=your-aws-smtp-username
EMAIL_SMTP_PASS=your-aws-smtp-password
EMAIL_FROM=noreply@adaptalabs.com
EMAIL_FROM_NAME=Adaptalabs Impact Lab
```

4. **Redeploy** so the backend pod picks up the new values (push to trigger a pipeline, or restart the pod)

## Testing Email Sending

After configuring SMTP:

1. **Make a booking** in the app
2. **Check your email** - you should receive a booking confirmation with calendar links
3. **Check the backend pod logs** - you should see "EMAIL SENT" instead of "EMAIL NOTIFICATION (Demo Mode)"

## Email Content

The booking confirmation email includes:
- ✅ **Google Calendar link** - Click to add event to Google Calendar
- ✅ **ICS file download** - Download .ics file for any calendar app
- ✅ **Session details** - Date, time, location, researcher info
- ✅ **Booking management link** - Link to manage bookings

## Troubleshooting

### Emails Still Not Sending

1. **Check the backend pod logs** (Kubera or `kubectl logs`):
   - Look for the `POST /api/bookings/sessions/:id/book` request
   - Check logs for email-related errors

2. **Verify Environment Variables**:
   - Make sure all SMTP variables are set
   - Check for typos in variable names
   - Ensure values don't have extra spaces

3. **Test SMTP Connection**:
   - The email service will log connection errors if SMTP fails
   - Check logs for authentication errors

### Common Errors

- **"Invalid login"**: Check SMTP username/password
- **"Connection timeout"**: Check SMTP host and port
- **"Authentication failed"**: Verify SMTP credentials are correct

## Demo Mode

If SMTP is not configured, the system will:
- Log emails to the backend console (pod logs)
- ✅ Include all calendar links in the logged email
- ⚠️ Not actually send emails

This is useful for development but **not suitable for production**.

## Next Steps

1. **Configure SMTP** using one of the options above
2. **Test with a booking** - make a test booking and verify email arrives
3. **Check calendar links** - verify Google Calendar link and ICS file work
4. **Monitor logs** - watch for any email sending errors

