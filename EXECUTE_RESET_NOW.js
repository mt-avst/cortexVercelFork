/**
 * EXECUTE DATABASE RESET NOW
 * 
 * Copy this entire script and paste into browser console
 * 
 * Steps:
 * 1. Go to https://adapta-labs-p62q.vercel.app
 * 2. Sign in as admin
 * 3. Press F12 to open console
 * 4. Paste this entire script
 * 5. Press Enter
 */

(async function executeReset() {
  console.log('🚀 Starting database reset on Vercel instance...');
  
  // First, try the new endpoint with sessions
  console.log('📡 Attempting reset with sessions...');
  
  try {
    const response = await fetch('/api/admin/reset-demo-data-with-sessions', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    const data = await response.json();
    
    if (response.ok && data.success) {
      console.log('✅ SUCCESS! Database reset complete with sessions!');
      console.log('📊 Created:', data.created);
      console.log('📅 Sessions:', data.sessions_created);
      
      alert(`✅ Database Reset Complete!\n\n` +
            `Created:\n` +
            `• ${data.created.opportunities.total} opportunities\n` +
            `• ${data.sessions_created} sessions\n\n` +
            `Refreshing page...`);
      
      setTimeout(() => window.location.reload(), 2000);
      return;
    }
    
    // If we get here, the endpoint exists but returned an error
    if (response.status === 401) {
      alert('❌ Not signed in. Please sign in as admin first!');
      return;
    }
    if (response.status === 403) {
      alert('❌ Admin access required. Please sign in as admin.');
      return;
    }
    
    throw new Error(data.error || data.message || 'Unknown error');
    
  } catch (error) {
    // If 404, try the existing endpoint
    if (error.message.includes('404') || error.message.includes('Not Found') || 
        (error.response && error.response.status === 404)) {
      
      console.log('⚠️ New endpoint not found. Trying existing endpoint (without sessions)...');
      
      try {
        const fallbackResponse = await fetch('/api/admin/reset-demo-data', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json'
          }
        });
        
        const fallbackData = await fallbackResponse.json();
        
        if (fallbackResponse.ok && fallbackData.success) {
          console.log('✅ SUCCESS! Database reset complete (no sessions)');
          console.log('📊 Created:', fallbackData.created);
          
          alert(`✅ Database Reset Complete!\n\n` +
                `Created ${fallbackData.created.total} opportunities.\n\n` +
                `⚠️ Note: No sessions created.\n` +
                `To get sessions, deploy the new endpoint first.\n\n` +
                `Refreshing page...`);
          
          setTimeout(() => window.location.reload(), 2000);
          return;
        }
        
        throw new Error(fallbackData.error || fallbackData.message || 'Reset failed');
        
      } catch (fallbackError) {
        console.error('❌ Both endpoints failed:', fallbackError);
        alert('❌ Reset failed. Please check:\n\n' +
              '1. You are signed in as admin\n' +
              '2. You are on the production site\n' +
              '3. Check console for details');
      }
    } else {
      console.error('❌ Error:', error);
      alert('❌ Reset failed: ' + error.message + '\n\nCheck console for details.');
    }
  }
})();

