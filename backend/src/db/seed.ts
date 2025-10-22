import { pool, config } from '../config';

export async function seedDatabase() {
  const client = await pool.connect();
  
  try {
    // Mark admin emails as researcher admins
    for (const email of config.ADMIN_EMAILS) {
      if (email.trim()) {
        await client.query(
          'UPDATE users SET role = $1 WHERE email = $2',
          ['researcher_admin', email.trim()]
        );
        console.log(`✅ Marked ${email.trim()} as researcher admin`);
      }
    }

    // Insert default settings
    await client.query(`
      INSERT INTO settings (key, value_json) 
      VALUES ('default_reminder_hours_before', '24')
      ON CONFLICT (key) DO NOTHING
    `);

    // Insert test opportunities
    await seedTestOpportunities(client);

    console.log('✅ Database seeding completed successfully');
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function seedTestOpportunities(client: any) {
  // Get admin user IDs for ownership
  const adminResult = await client.query(
    'SELECT id FROM users WHERE role = $1 LIMIT 2',
    ['researcher_admin']
  );
  
  if (adminResult.rows.length === 0) {
    console.log('⚠️ No admin users found, skipping opportunity seeding');
    return;
  }

  const admin1Id = adminResult.rows[0].id;
  const admin2Id = adminResult.rows[1]?.id || admin1Id;

  const testOpportunities = [
    {
      type: 'test',
      title: 'User Interface Testing',
      purpose_one_liner: 'Help us test the new dashboard interface to improve user experience',
      description_optional: 'We need volunteers to test our new dashboard interface. This will involve navigating through different sections and providing feedback on usability.',
      product_optional: 'Customer Dashboard',
      default_duration_minutes: 45,
      status: 'published',
      owner_user_id: admin1Id,
      external_link_optional: null,
      participant_type_required: 'internal',
      participant_type_specific_details: null
    },
    {
      type: 'poll',
      title: 'Feature Preference Survey',
      purpose_one_liner: 'Share your preferences for upcoming product features',
      description_optional: 'We want to understand which features are most important to our users.',
      product_optional: 'Mobile App',
      default_duration_minutes: 15,
      status: 'published',
      owner_user_id: admin2Id,
      external_link_optional: 'https://forms.google.com/example-poll',
      participant_type_required: 'any',
      participant_type_specific_details: null
    },
    {
      type: 'survey',
      title: 'Workplace Satisfaction Survey',
      purpose_one_liner: 'Help us understand workplace satisfaction and identify areas for improvement',
      description_optional: 'Your feedback is crucial for creating a better work environment for everyone.',
      product_optional: null,
      default_duration_minutes: 20,
      status: 'published',
      owner_user_id: admin1Id,
      external_link_optional: 'https://surveymonkey.com/example-survey',
      participant_type_required: 'internal',
      participant_type_specific_details: null
    },
    {
      type: 'test',
      title: 'Mobile App Beta Testing',
      purpose_one_liner: 'Test our new mobile app features before public release',
      description_optional: 'We need beta testers to try out new features and report any bugs or issues.',
      product_optional: 'Mobile App',
      default_duration_minutes: 60,
      status: 'draft',
      owner_user_id: admin2Id,
      external_link_optional: null,
      participant_type_required: 'external',
      participant_type_specific_details: null
    },
    {
      type: 'test',
      title: 'API Performance Testing',
      purpose_one_liner: 'Help us test API performance under various load conditions',
      description_optional: 'We need to test how our APIs perform under different load conditions.',
      product_optional: 'Backend Services',
      default_duration_minutes: 90,
      status: 'closed',
      owner_user_id: admin1Id,
      external_link_optional: null,
      participant_type_required: 'specific',
      participant_type_specific_details: 'Must have 3+ years experience with React and TypeScript. Experience with testing frameworks like Jest and Cypress preferred.'
    },
    {
      type: 'test',
      title: 'Accessibility Testing',
      purpose_one_liner: 'Help us ensure our application is accessible to all users',
      description_optional: 'We need volunteers to test our application with screen readers and other accessibility tools.',
      product_optional: 'Web Application',
      default_duration_minutes: 30,
      status: 'published',
      owner_user_id: admin2Id,
      external_link_optional: null,
      participant_type_required: 'any',
      participant_type_specific_details: null
    },
    {
      type: 'poll',
      title: 'Design System Feedback',
      purpose_one_liner: 'Share your thoughts on our new design system components',
      description_optional: 'We are updating our design system and need your input on the new components.',
      product_optional: 'Design System',
      default_duration_minutes: 25,
      status: 'published',
      owner_user_id: admin1Id,
      external_link_optional: 'https://forms.google.com/design-feedback',
      participant_type_required: 'internal',
      participant_type_specific_details: null
    },
    {
      type: 'survey',
      title: 'Product Usage Analytics',
      purpose_one_liner: 'Help us understand how you use our products in your daily workflow',
      description_optional: 'Understanding usage patterns helps us prioritize features and improvements.',
      product_optional: 'Product Suite',
      default_duration_minutes: 35,
      status: 'published',
      owner_user_id: admin2Id,
      external_link_optional: 'https://surveymonkey.com/usage-analytics',
      participant_type_required: 'internal',
      participant_type_specific_details: null
    },
    {
      type: 'test',
      title: 'Security Testing',
      purpose_one_liner: 'Help us identify potential security vulnerabilities in our systems',
      description_optional: 'We need security-conscious users to help us test for potential vulnerabilities.',
      product_optional: 'Security Platform',
      default_duration_minutes: 75,
      status: 'published',
      owner_user_id: admin1Id,
      external_link_optional: null,
      participant_type_required: 'specific',
      participant_type_specific_details: 'Must have experience with security testing and vulnerability assessment.'
    },
    {
      type: 'poll',
      title: 'Training Preferences',
      purpose_one_liner: 'Tell us about your preferred learning methods and training formats',
      description_optional: 'We want to improve our training programs based on your preferences.',
      product_optional: null,
      default_duration_minutes: 10,
      status: 'published',
      owner_user_id: admin2Id,
      external_link_optional: 'https://forms.google.com/training-preferences',
      participant_type_required: 'any',
      participant_type_specific_details: null
    },
    {
      type: 'test',
      title: 'Cross-Platform Compatibility',
      purpose_one_liner: 'Test our application across different browsers and operating systems',
      description_optional: 'We need to ensure our application works consistently across various platforms.',
      product_optional: 'Web Application',
      default_duration_minutes: 50,
      status: 'published',
      owner_user_id: admin1Id,
      external_link_optional: null,
      participant_type_required: 'any',
      participant_type_specific_details: null
    },
    {
      type: 'survey',
      title: 'Customer Support Experience',
      purpose_one_liner: 'Share your experience with our customer support team',
      description_optional: 'Help us improve our customer support by sharing your recent experiences.',
      product_optional: 'Support Platform',
      default_duration_minutes: 15,
      status: 'published',
      owner_user_id: admin2Id,
      external_link_optional: 'https://surveymonkey.com/support-experience',
      participant_type_required: 'any',
      participant_type_specific_details: null
    },
    {
      type: 'question',
      title: 'What is your biggest challenge with our current tools?',
      purpose_one_liner: 'Tell us about the main obstacle you face when using our products',
      description_optional: 'Help us identify the most significant pain points in our current toolset. Your input will directly influence our product roadmap.',
      product_optional: 'Development Tools',
      default_duration_minutes: 3,
      status: 'published',
      owner_user_id: admin1Id,
      external_link_optional: null,
      participant_type_required: 'internal',
      participant_type_specific_details: null
    },
    {
      type: 'test',
      title: 'Performance Testing',
      purpose_one_liner: 'Help us test application performance under various conditions',
      description_optional: 'We need volunteers to test how our application performs under different load conditions and usage patterns.',
      product_optional: 'Web Application',
      default_duration_minutes: 40,
      status: 'draft',
      owner_user_id: admin2Id,
      external_link_optional: null,
      participant_type_required: 'external',
      participant_type_specific_details: null
    },
    {
      type: 'poll',
      title: 'Feature Request Priority',
      purpose_one_liner: 'Help us prioritize which features to build next',
      description_optional: 'Your input helps us decide which features will have the biggest impact on your workflow.',
      product_optional: 'Product Suite',
      default_duration_minutes: 12,
      status: 'published',
      owner_user_id: admin1Id,
      external_link_optional: 'https://forms.google.com/feature-priority',
      participant_type_required: 'any',
      participant_type_specific_details: null
    }
  ];

  for (const opportunity of testOpportunities) {
    await client.query(`
      INSERT INTO opportunities (
        type, title, purpose_one_liner, description_optional, 
        product_optional, default_duration_minutes, status, 
        owner_user_id, external_link_optional, participant_type_required, participant_type_specific_details
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (title) DO UPDATE SET
        type = EXCLUDED.type,
        purpose_one_liner = EXCLUDED.purpose_one_liner,
        description_optional = EXCLUDED.description_optional,
        product_optional = EXCLUDED.product_optional,
        default_duration_minutes = EXCLUDED.default_duration_minutes,
        status = EXCLUDED.status,
        external_link_optional = EXCLUDED.external_link_optional,
        participant_type_required = EXCLUDED.participant_type_required,
        participant_type_specific_details = EXCLUDED.participant_type_specific_details
    `, [
      opportunity.type,
      opportunity.title,
      opportunity.purpose_one_liner,
      opportunity.description_optional,
      opportunity.product_optional,
      opportunity.default_duration_minutes,
      opportunity.status,
      opportunity.owner_user_id,
      opportunity.external_link_optional,
      opportunity.participant_type_required || 'any',
      opportunity.participant_type_specific_details || null
    ]);
  }

  console.log(`✅ Seeded ${testOpportunities.length} test opportunities`);
}

// Run seeding if this file is executed directly
if (require.main === module) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
