/**
 * Database Reset Script - Run This Now
 * 
 * INSTRUCTIONS:
 * 1. Go to: https://adapta-labs-p62q.vercel.app
 * 2. Sign in as admin (use demo admin login if needed)
 * 3. Open browser console (F12 or Cmd+Option+J)
 * 4. Copy and paste this ENTIRE script
 * 5. Press Enter
 * 
 * This will:
 * - Reset the database
 * - Create 6 opportunities with 60 sessions
 * - Refresh the page automatically
 */

(async function resetDatabaseNow() {
  console.log('🔄 Starting database reset...');
  console.log('📡 Calling: /api/admin/reset-demo-data-with-sessions');
  
  try {
    const response = await fetch('/api/admin/reset-demo-data-with-sessions', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    console.log('📥 Response status:', response.status);
    
    const data = await response.json();
    console.log('📦 Response data:', data);
    
    if (response.ok && data.success) {
      console.log('✅ Database reset successful!');
      console.log('📊 Created:', data.created);
      console.log('📅 Sessions created:', data.sessions_created);
      console.log('\n🔄 Refreshing page in 3 seconds...');
      
      // Show success message
      alert(`✅ Database Reset Complete!\n\n` +
            `Created:\n` +
            `- ${data.created.opportunities.total} opportunities\n` +
            `- ${data.sessions_created} sessions\n\n` +
            `Page will refresh automatically...`);
      
      setTimeout(() => {
        window.location.reload();
      }, 3000);
    } else {
      // Handle different error cases
      if (response.status === 404) {
        console.error('❌ Endpoint not found (404)');
        console.log('💡 The endpoint may not be deployed yet.');
        console.log('💡 Try using the existing endpoint instead:');
        console.log('   fetch("/api/admin/reset-demo-data", { method: "POST", credentials: "include" })');
        alert('❌ Endpoint not found. The new endpoint may need to be deployed first.\n\n' +
              'Try using the existing reset endpoint or deploy the new file first.');
      } else if (response.status === 401) {
        console.error('❌ Not authenticated');
        alert('❌ Please sign in as admin first!');
      } else if (response.status === 403) {
        console.error('❌ Not authorized');
        alert('❌ Admin access required. Please sign in as admin.');
      } else {
        console.error('❌ Reset failed:', data.error || data.message);
        alert('❌ Reset failed: ' + (data.error || data.message || 'Unknown error'));
      }
    }
  } catch (error) {
    console.error('❌ Network error:', error);
    alert('❌ Network error. Check console for details.\n\n' +
          'Make sure you are:\n' +
          '1. On the production site\n' +
          '2. Signed in as admin\n' +
          '3. The endpoint is deployed');
  }
})();

