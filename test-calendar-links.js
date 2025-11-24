#!/usr/bin/env node
/**
 * Quick test script for calendar link generation
 * Run: node test-calendar-links.js
 */

// Simple test without importing the full codebase
function formatDateForGoogle(date) {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function generateGoogleCalendarLink(title, startTime, endTime, description, location) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${formatDateForGoogle(startTime)}/${formatDateForGoogle(endTime)}`,
    details: description || '',
    location: location || '',
  });
  
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function escapeICS(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function generateICSFile(title, startTime, endTime, description, location, organizerEmail, organizerName) {
  const formatICSDate = (date) => {
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
    `SUMMARY:${escapeICS(title)}`,
    description ? `DESCRIPTION:${escapeICS(description)}` : '',
    location ? `LOCATION:${escapeICS(location)}` : '',
    organizerEmail ? `ORGANIZER;CN=${escapeICS(organizerName || organizerEmail)}:MAILTO:${organizerEmail}` : '',
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  
  return icsContent;
}

// Test data
const testStartTime = new Date('2024-12-15T10:00:00Z');
const testEndTime = new Date('2024-12-15T11:00:00Z');
const testTitle = 'Research Session: User Testing';
const testDescription = 'Research session: User Testing\n\nResearcher: John Doe';
const testLocation = 'Conference Room A';
const testOrganizerEmail = 'researcher@adaptalabs.com';
const testOrganizerName = 'John Doe';

console.log('🧪 Testing Calendar Link Generation\n');
console.log('='.repeat(60));

// Test Google Calendar Link
console.log('\n1️⃣ Google Calendar Link:');
const googleLink = generateGoogleCalendarLink(
  testTitle,
  testStartTime,
  testEndTime,
  testDescription,
  testLocation
);
console.log(googleLink);
console.log('\n📋 Copy this URL and paste in browser to test\n');

// Test ICS File
console.log('2️⃣ ICS File Content:');
const icsContent = generateICSFile(
  testTitle,
  testStartTime,
  testEndTime,
  testDescription,
  testLocation,
  testOrganizerEmail,
  testOrganizerName
);
console.log(icsContent);
console.log('\n📋 This should be valid ICS format\n');

// Test data URI
console.log('3️⃣ Data URI (for email download link):');
const dataUri = `data:text/calendar;charset=utf-8,${encodeURIComponent(icsContent)}`;
console.log(dataUri.substring(0, 100) + '...');
console.log('\n📋 First 100 chars shown (full URI is much longer)\n');

// Create test HTML file
console.log('4️⃣ Creating test HTML file: test-calendar.html');
const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <title>Calendar Link Test</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
    .button { display: inline-block; padding: 12px 24px; margin: 10px 5px; 
              text-decoration: none; border-radius: 4px; font-weight: bold; }
    .google { background-color: #4285f4; color: white; }
    .ics { background-color: #6c757d; color: white; }
  </style>
</head>
<body>
  <h1>Calendar Link Test</h1>
  <p>Click the buttons below to test calendar links:</p>
  
  <div>
    <a href="${googleLink}" target="_blank" class="button google">
      📅 Add to Google Calendar
    </a>
    <a href="${dataUri}" download="test-booking.ics" class="button ics">
      📥 Download Calendar File (.ics)
    </a>
  </div>
  
  <h2>Test Details</h2>
  <ul>
    <li><strong>Title:</strong> ${testTitle}</li>
    <li><strong>Start:</strong> ${testStartTime.toLocaleString()}</li>
    <li><strong>End:</strong> ${testEndTime.toLocaleString()}</li>
    <li><strong>Location:</strong> ${testLocation}</li>
    <li><strong>Organizer:</strong> ${testOrganizerName} (${testOrganizerEmail})</li>
  </ul>
  
  <h2>Expected Results</h2>
  <ul>
    <li><strong>Google Calendar:</strong> Should open Google Calendar with pre-filled event</li>
    <li><strong>ICS File:</strong> Should download and can be imported into any calendar app</li>
  </ul>
</body>
</html>`;

require('fs').writeFileSync('test-calendar.html', htmlContent);
console.log('✅ Created test-calendar.html - Open it in your browser to test!\n');

console.log('='.repeat(60));
console.log('\n✅ Test complete!');
console.log('\nNext steps:');
console.log('1. Open test-calendar.html in your browser');
console.log('2. Click "Add to Google Calendar" - should open Google Calendar');
console.log('3. Click "Download Calendar File" - should download .ics file');
console.log('4. Import the .ics file into your calendar app to verify it works');

