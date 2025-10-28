const { Pool } = require('pg');

async function updateOpportunityStatus() {
  const pool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'adaptalabs_dev',
    user: 'postgres',
    password: 'password'
  });

  try {
    const opportunityId = 'a4493370-ef0d-4a18-9e97-2da7490e4c51';
    
    const result = await pool.query(
      'UPDATE opportunities SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      ['published', opportunityId]
    );
    
    if (result.rows.length > 0) {
      console.log('✅ Opportunity updated successfully:');
      console.log(`Title: ${result.rows[0].title}`);
      console.log(`Status: ${result.rows[0].status}`);
      console.log(`Updated: ${result.rows[0].updated_at}`);
    } else {
      console.log('❌ No opportunity found with that ID');
    }
  } catch (error) {
    console.error('❌ Error updating opportunity:', error.message);
  } finally {
    await pool.end();
  }
}

updateOpportunityStatus();

