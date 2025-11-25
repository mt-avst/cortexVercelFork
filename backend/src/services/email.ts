import nodemailer from 'nodemailer';
import { logger } from '../utils/logger';

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

export interface EmailRecipient {
  email: string;
  name: string;
}

export interface EmailServiceConfig {
  fromEmail?: string;
  fromName?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
}

export class EmailService {
  private config: EmailServiceConfig;

  constructor(config: EmailServiceConfig = {}) {
    // Trim and remove spaces from SMTP password (App Passwords often have spaces when copied)
    const smtpPass = config.smtpPass 
      ? config.smtpPass.trim().replace(/\s+/g, '')
      : undefined;
    
    this.config = {
      fromEmail: config.fromEmail || 'noreply@adaptalabs.com',
      fromName: config.fromName || 'Adaptalabs Impact Lab',
      ...config,
      smtpPass: smtpPass, // Use trimmed password
    };
  }

  async sendEmail(
    to: EmailRecipient | EmailRecipient[],
    template: EmailTemplate
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const recipients = Array.isArray(to) ? to : [to];
      
      // Check if SMTP is configured
      const hasSmtpConfig = this.config.smtpHost && this.config.smtpUser && this.config.smtpPass;
      
      // Debug logging using logger (visible in Vercel logs)
      logger.info('📧 Email Service Debug:', {
        hasSmtpConfig,
        smtpHost: this.config.smtpHost ? 'SET' : 'MISSING',
        smtpUser: this.config.smtpUser ? 'SET' : 'MISSING',
        smtpPass: this.config.smtpPass ? 'SET' : 'MISSING',
        smtpPort: this.config.smtpPort,
        fromEmail: this.config.fromEmail,
        fromName: this.config.fromName,
      });
      
      if (hasSmtpConfig) {
        // Send real email using Nodemailer
        const transporter = nodemailer.createTransport({
          host: this.config.smtpHost,
          port: this.config.smtpPort || 587,
          secure: this.config.smtpPort === 465, // true for 465, false for other ports
          auth: {
            user: this.config.smtpUser,
            pass: this.config.smtpPass,
          },
        });
        
        // Send email to all recipients
        const results = await Promise.all(
          recipients.map(async (recipient) => {
            const info = await transporter.sendMail({
              from: `"${this.config.fromName}" <${this.config.fromEmail}>`,
              to: `${recipient.name} <${recipient.email}>`,
              subject: template.subject,
              text: template.text,
              html: template.html,
            });
            
            logger.info('📧 EMAIL SENT:', {
              to: recipient.email,
              messageId: info.messageId,
              response: info.response,
            });
            
            return info.messageId;
          })
        );
        
        return { success: true, messageId: results[0] };
      } else {
        // Demo mode: Log the email instead of sending
        logger.warn('📧 EMAIL NOTIFICATION (Demo Mode - not sent)', {
          from: `${this.config.fromName} <${this.config.fromEmail}>`,
          to: recipients.map(r => `${r.name} <${r.email}>`).join(', '),
          subject: template.subject,
          missingConfig: {
            EMAIL_SMTP_HOST: this.config.smtpHost || 'MISSING',
            EMAIL_SMTP_PORT: this.config.smtpPort || 'MISSING',
            EMAIL_SMTP_USER: this.config.smtpUser || 'MISSING',
            EMAIL_SMTP_PASS: this.config.smtpPass ? 'SET' : 'MISSING',
          },
        });
        
        const mockMessageId = `email-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        return { success: true, messageId: mockMessageId };
      }
    } catch (error: any) {
      logger.error('❌ Email sending failed:', {
        error: error.message,
        stack: error.stack,
        code: error.code,
        command: error.command,
        response: error.response,
        responseCode: error.responseCode,
        fullError: error,
      });
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate Google Calendar link for adding event
   */
  static generateGoogleCalendarLink(
    title: string,
    startTime: Date,
    endTime: Date,
    description?: string,
    location?: string
  ): string {
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: title,
      dates: `${this.formatDateForGoogle(startTime)}/${this.formatDateForGoogle(endTime)}`,
      details: description || '',
      location: location || '',
    });
    
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  /**
   * Format date for Google Calendar (YYYYMMDDTHHmmssZ)
   */
  static formatDateForGoogle(date: Date): string {
    return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  }

  /**
   * Generate .ics file content (iCalendar format)
   */
  static generateICSFile(
    title: string,
    startTime: Date,
    endTime: Date,
    description?: string,
    location?: string,
    organizerEmail?: string,
    organizerName?: string
  ): string {
    const formatICSDate = (date: Date) => {
      return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    };
    
    const icsContent = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//AdaptaLabs//Research Platform//EN',
      'BEGIN:VEVENT',
      `UID:${Date.now()}@adaptalabs.com`,
      `DTSTAMP:${formatICSDate(new Date())}`,
      `DTSTART:${formatICSDate(startTime)}`,
      `DTEND:${formatICSDate(endTime)}`,
      `SUMMARY:${this.escapeICS(title)}`,
      description ? `DESCRIPTION:${this.escapeICS(description)}` : '',
      location ? `LOCATION:${this.escapeICS(location)}` : '',
      organizerEmail ? `ORGANIZER;CN=${this.escapeICS(organizerName || organizerEmail)}:MAILTO:${organizerEmail}` : '',
      'STATUS:CONFIRMED',
      'END:VEVENT',
      'END:VCALENDAR',
    ].filter(Boolean).join('\r\n');
    
    return icsContent;
  }

  static escapeICS(text: string): string {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  }

  static getFeedbackTemplate(
    category: string,
    feedback: string,
    userName: string,
    userEmail: string,
    userAgent: string,
    url: string
  ): EmailTemplate {
    const subject = `[AdaptaLabs Feedback] ${category === 'bug' ? 'Bug Report' : category === 'feature' ? 'Feature Request' : category === 'question' ? 'Question' : 'Feedback'}`;
    
    const html = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>New Feedback Received</h2>
        <p><strong>Category:</strong> ${category}</p>
        <p><strong>User:</strong> ${userName} (${userEmail})</p>
        <hr />
        <h3>Feedback:</h3>
        <p style="white-space: pre-wrap;">${feedback}</p>
        <hr />
        <p><small><strong>Browser:</strong> ${userAgent}</small></p>
        <p><small><strong>URL:</strong> ${url}</small></p>
        <p><small><strong>Timestamp:</strong> ${new Date().toISOString()}</small></p>
      </div>
    `;

    const text = `
New Feedback Received
---------------------
Category: ${category}
User: ${userName} (${userEmail})

Feedback:
${feedback}

---
Browser: ${userAgent}
URL: ${url}
Timestamp: ${new Date().toISOString()}
    `;

    return { subject, html, text };
  }

  // Email templates
  static getBookingConfirmationTemplate(
    opportunityTitle: string,
    participantName: string,
    sessionStartTime: Date,
    sessionEndTime: Date,
    sessionLocation?: string,
    ownerName?: string,
    ownerEmail?: string
  ): EmailTemplate {
    const startTime = sessionStartTime.toLocaleString();
    const endTime = sessionEndTime.toLocaleString();
    const duration = Math.round((sessionEndTime.getTime() - sessionStartTime.getTime()) / (1000 * 60));
    
    // Generate calendar links
    const description = `Research session: ${opportunityTitle}${ownerName ? `\n\nResearcher: ${ownerName}` : ''}`;
    const googleCalendarLink = this.generateGoogleCalendarLink(
      opportunityTitle,
      sessionStartTime,
      sessionEndTime,
      description,
      sessionLocation
    );
    
    const icsContent = this.generateICSFile(
      opportunityTitle,
      sessionStartTime,
      sessionEndTime,
      description,
      sessionLocation,
      ownerEmail,
      ownerName
    );
    
    // Encode ICS content for data URI (for download link)
    const icsDataUri = `data:text/calendar;charset=utf-8,${encodeURIComponent(icsContent)}`;
    
    const subject = `Booking confirmed: ${opportunityTitle}`;
    
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Booking Confirmed</h2>
        
        <p>Hello ${participantName},</p>
        
        <p>Your booking has been confirmed for the following research session:</p>
        
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="margin-top: 0; color: #495057;">${opportunityTitle}</h3>
          <p><strong>Date & Time:</strong> ${startTime} - ${endTime}</p>
          <p><strong>Duration:</strong> ${duration} minutes</p>
          ${sessionLocation ? `<p><strong>Location:</strong> ${sessionLocation}</p>` : ''}
          ${ownerName ? `<p><strong>Researcher:</strong> ${ownerName}${ownerEmail ? ` (${ownerEmail})` : ''}</p>` : ''}
        </div>
        
        <div style="text-align: center; margin: 25px 0;">
          <a href="${googleCalendarLink}" 
             target="_blank"
             style="background-color: #4285f4; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: bold; margin: 5px;">
            📅 Add to Google Calendar
          </a>
          <a href="${icsDataUri}" 
             download="booking.ics"
             style="background-color: #6c757d; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: bold; margin: 5px;">
            📥 Download Calendar File
          </a>
        </div>
        
        <p>Please make sure to:</p>
        <ul>
          <li>Add this to your calendar using the links above</li>
          <li>Prepare any materials requested by the researcher</li>
          <li>Arrive on time for the session</li>
        </ul>
        
        <p>If you need to reschedule or cancel, you can manage your booking at:</p>
        <p><a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/my-bookings" style="color: #007bff;">My Bookings</a></p>
        
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #dee2e6;">
        <p style="color: #6c757d; font-size: 14px;">
          This is an automated message from the Adaptalabs Impact Lab.
        </p>
      </div>
    `;
    
    const text = `
Booking Confirmed

Hello ${participantName},

Your booking has been confirmed for the following research session:

${opportunityTitle}
Date & Time: ${startTime} - ${endTime}
Duration: ${duration} minutes
${sessionLocation ? `Location: ${sessionLocation}` : ''}
${ownerName ? `Researcher: ${ownerName}${ownerEmail ? ` (${ownerEmail})` : ''}` : ''}

Add to your calendar:
Google Calendar: ${googleCalendarLink}

Please make sure to:
- Add this to your calendar
- Prepare any materials requested by the researcher
- Arrive on time for the session

If you need to reschedule or cancel, you can manage your booking at:
${process.env.FRONTEND_URL || 'http://localhost:3000'}/my-bookings

This is an automated message from the Adaptalabs Impact Lab.
    `;
    
    return { subject, html, text };
  }

  static getBookingCancellationTemplate(
    opportunityTitle: string,
    participantName: string,
    sessionStartTime: Date,
    sessionEndTime: Date,
    cancelledBy: string
  ): EmailTemplate {
    const startTime = sessionStartTime.toLocaleString();
    const endTime = sessionEndTime.toLocaleString();
    
    const subject = `Booking cancelled: ${opportunityTitle}`;
    
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #dc3545;">Booking Cancelled</h2>
        
        <p>Hello ${participantName},</p>
        
        <p>Your booking for the following research session has been cancelled:</p>
        
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="margin-top: 0; color: #495057;">${opportunityTitle}</h3>
          <p><strong>Date & Time:</strong> ${startTime} - ${endTime}</p>
          <p><strong>Cancelled by:</strong> ${cancelledBy}</p>
        </div>
        
        <p>If you have any questions about this cancellation, please contact the researcher directly.</p>
        
        <p>You can view other available opportunities at:</p>
        <p><a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}" style="color: #007bff;">Impact Lab</a></p>
        
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #dee2e6;">
        <p style="color: #6c757d; font-size: 14px;">
          This is an automated message from the Adaptalabs Impact Lab.
        </p>
      </div>
    `;
    
    const text = `
Booking Cancelled

Hello ${participantName},

Your booking for the following research session has been cancelled:

${opportunityTitle}
Date & Time: ${startTime} - ${endTime}
Cancelled by: ${cancelledBy}

If you have any questions about this cancellation, please contact the researcher directly.

You can view other available opportunities at:
${process.env.FRONTEND_URL || 'http://localhost:3000'}

This is an automated message from the Adaptalabs Impact Lab.
    `;
    
    return { subject, html, text };
  }

  static getBookingReminderTemplate(
    opportunityTitle: string,
    participantName: string,
    sessionStartTime: Date,
    sessionEndTime: Date,
    sessionLocation?: string,
    ownerName?: string
  ): EmailTemplate {
    const startTime = sessionStartTime.toLocaleString();
    const endTime = sessionEndTime.toLocaleString();
    const hoursUntil = Math.round((sessionStartTime.getTime() - new Date().getTime()) / (1000 * 60 * 60));
    
    const subject = `Reminder: ${opportunityTitle} in ${hoursUntil} hours`;
    
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #ffc107;">Session Reminder</h2>
        
        <p>Hello ${participantName},</p>
        
        <p>This is a reminder that you have a research session coming up:</p>
        
        <div style="background-color: #fff3cd; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ffc107;">
          <h3 style="margin-top: 0; color: #856404;">${opportunityTitle}</h3>
          <p><strong>Date & Time:</strong> ${startTime} - ${endTime}</p>
          <p><strong>Starting in:</strong> ${hoursUntil} hours</p>
          ${sessionLocation ? `<p><strong>Location:</strong> ${sessionLocation}</p>` : ''}
          ${ownerName ? `<p><strong>Researcher:</strong> ${ownerName}</p>` : ''}
        </div>
        
        <p>Please make sure you're prepared and ready for the session.</p>
        
        <p>If you need to reschedule or cancel, you can manage your booking at:</p>
        <p><a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/my-bookings" style="color: #007bff;">My Bookings</a></p>
        
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #dee2e6;">
        <p style="color: #6c757d; font-size: 14px;">
          This is an automated reminder from the Adaptalabs Impact Lab.
        </p>
      </div>
    `;
    
    const text = `
Session Reminder

Hello ${participantName},

This is a reminder that you have a research session coming up:

${opportunityTitle}
Date & Time: ${startTime} - ${endTime}
Starting in: ${hoursUntil} hours
${sessionLocation ? `Location: ${sessionLocation}` : ''}
${ownerName ? `Researcher: ${ownerName}` : ''}

Please make sure you're prepared and ready for the session.

If you need to reschedule or cancel, you can manage your booking at:
${process.env.FRONTEND_URL || 'http://localhost:3000'}/my-bookings

This is an automated reminder from the Adaptalabs Impact Lab.
    `;
    
    return { subject, html, text };
  }

  static getAdminNotificationTemplate(
    opportunityTitle: string,
    participantName: string,
    participantEmail: string,
    sessionStartTime: Date,
    sessionEndTime: Date,
    action: 'booked' | 'cancelled'
  ): EmailTemplate {
    const startTime = sessionStartTime.toLocaleString();
    const endTime = sessionEndTime.toLocaleString();
    
    const subject = `Participant ${action}: ${opportunityTitle}`;
    
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: ${action === 'booked' ? '#28a745' : '#dc3545'};">Participant ${action === 'booked' ? 'Booked' : 'Cancelled'}</h2>
        
        <p>A participant has ${action} your research session:</p>
        
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="margin-top: 0; color: #495057;">${opportunityTitle}</h3>
          <p><strong>Date & Time:</strong> ${startTime} - ${endTime}</p>
          <p><strong>Participant:</strong> ${participantName} (${participantEmail})</p>
          <p><strong>Action:</strong> ${action === 'booked' ? 'Booked' : 'Cancelled'}</p>
        </div>
        
        <p>You can manage your opportunities at:</p>
        <p><a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/admin" style="color: #007bff;">Admin Dashboard</a></p>
        
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #dee2e6;">
        <p style="color: #6c757d; font-size: 14px;">
          This is an automated notification from the Adaptalabs Impact Lab.
        </p>
      </div>
    `;
    
    const text = `
Participant ${action === 'booked' ? 'Booked' : 'Cancelled'}

A participant has ${action} your research session:

${opportunityTitle}
Date & Time: ${startTime} - ${endTime}
Participant: ${participantName} (${participantEmail})
Action: ${action === 'booked' ? 'Booked' : 'Cancelled'}

You can manage your opportunities at:
${process.env.FRONTEND_URL || 'http://localhost:3000'}/admin

This is an automated notification from the Adaptalabs Impact Lab.
    `;
    
    return { subject, html, text };
  }
}

// Create a singleton instance
// Note: Password trimming is handled in EmailService constructor
const emailService = new EmailService({
  fromEmail: process.env.EMAIL_FROM || 'noreply@adaptalabs.com',
  fromName: process.env.EMAIL_FROM_NAME || 'Adaptalabs Impact Lab',
  smtpHost: process.env.EMAIL_SMTP_HOST,
  smtpPort: process.env.EMAIL_SMTP_PORT ? parseInt(process.env.EMAIL_SMTP_PORT, 10) : undefined,
  smtpUser: process.env.EMAIL_SMTP_USER,
  smtpPass: process.env.EMAIL_SMTP_PASS, // Will be trimmed in constructor
});

export default emailService;
