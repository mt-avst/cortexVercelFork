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
    this.config = {
      fromEmail: config.fromEmail || 'noreply@adaptalabs.com',
      fromName: config.fromName || 'Adaptalabs Research Platform',
      ...config
    };
  }

  async sendEmail(
    to: EmailRecipient | EmailRecipient[],
    template: EmailTemplate
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const recipients = Array.isArray(to) ? to : [to];
      
      // For demo purposes, log the email instead of sending
      console.log('📧 EMAIL NOTIFICATION');
      console.log('From:', `${this.config.fromName} <${this.config.fromEmail}>`);
      console.log('To:', recipients.map(r => `${r.name} <${r.email}>`).join(', '));
      console.log('Subject:', template.subject);
      console.log('Text:', template.text);
      console.log('---');
      
      // In production, you would use a real email service like:
      // - Nodemailer with SMTP
      // - SendGrid
      // - AWS SES
      // - Mailgun
      
      const mockMessageId = `email-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      return { success: true, messageId: mockMessageId };
    } catch (error: any) {
      console.error('Email sending failed:', error);
      return { success: false, error: error.message };
    }
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
          ${ownerName ? `<p><strong>Researcher:</strong> ${ownerName} (${ownerEmail})</p>` : ''}
        </div>
        
        <p>Please make sure to:</p>
        <ul>
          <li>Add this to your calendar</li>
          <li>Prepare any materials requested by the researcher</li>
          <li>Arrive on time for the session</li>
        </ul>
        
        <p>If you need to reschedule or cancel, you can manage your booking at:</p>
        <p><a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/my-bookings" style="color: #007bff;">My Bookings</a></p>
        
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #dee2e6;">
        <p style="color: #6c757d; font-size: 14px;">
          This is an automated message from the Adaptalabs Research Platform.
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
${ownerName ? `Researcher: ${ownerName} (${ownerEmail})` : ''}

Please make sure to:
- Add this to your calendar
- Prepare any materials requested by the researcher
- Arrive on time for the session

If you need to reschedule or cancel, you can manage your booking at:
${process.env.FRONTEND_URL || 'http://localhost:3000'}/my-bookings

This is an automated message from the Adaptalabs Research Platform.
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
        <p><a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}" style="color: #007bff;">Research Opportunities</a></p>
        
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #dee2e6;">
        <p style="color: #6c757d; font-size: 14px;">
          This is an automated message from the Adaptalabs Research Platform.
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

This is an automated message from the Adaptalabs Research Platform.
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
          This is an automated reminder from the Adaptalabs Research Platform.
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

This is an automated reminder from the Adaptalabs Research Platform.
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
          This is an automated notification from the Adaptalabs Research Platform.
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

This is an automated notification from the Adaptalabs Research Platform.
    `;
    
    return { subject, html, text };
  }
}

// Create a singleton instance
const emailService = new EmailService({
  fromEmail: process.env.EMAIL_FROM || 'noreply@adaptalabs.com',
  fromName: process.env.EMAIL_FROM_NAME || 'Adaptalabs Research Platform',
});

export default emailService;
