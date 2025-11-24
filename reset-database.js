/**
 * Quick Database Reset Script
 * 
 * Run this from browser console when logged in as admin
 * 
 * Usage:
 * 1. Go to https://adapta-labs-p62q.vercel.app
 * 2. Sign in as admin
 * 3. Open browser console (F12)
 * 4. Copy and paste this entire script
 * 5. Press Enter
 */

(async function resetDatabase() {
  console.log('🔄 Starting database reset...');
  
  try {
    // Reset with sessions (recommended for alpha testing)
    const response = await fetch('/api/admin/reset-demo-data-with-sessions', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    const data = await response.json();
    
    if (response.ok && data.success) {
      console.log('✅ Database reset successful!');
      console.log('📊 Created:', data.created);
      console.log('📅 Sessions created:', data.sessions_created);
      console.log('\n🔄 Refreshing page in 2 seconds...');
      
      setTimeout(() => {
        window.location.reload();
      }, 2000);
    } else {
      console.error('❌ Reset failed:', data.error || data.message);
      alert('Reset failed: ' + (data.error || data.message));
    }
  } catch (error) {
    console.error('❌ Error:', error);
    alert('Reset failed. Check console for details.');
  }
})();

