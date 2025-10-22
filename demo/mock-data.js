"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteMockOpportunity = exports.updateMockOpportunity = exports.addMockOpportunity = exports.getMockOpportunity = exports.getMockOpportunities = exports.mockOpportunities = void 0;
// Mock data service for development when database is not available
let dynamicMockOpportunities = [
    {
        id: '1',
        type: 'test',
        title: 'User Interface Testing',
        purpose_one_liner: 'Help us test the new dashboard interface to improve user experience',
        description_optional: 'We need volunteers to test our new dashboard interface. This will involve navigating through different sections and providing feedback on usability.',
        product_optional: 'Customer Dashboard',
        default_duration_minutes: 45,
        status: 'published',
        owner_user_id: 'demo-admin-456',
        external_link_optional: null,
        participant_type_required: 'internal',
        participant_type_specific_details: null,
        created_at: new Date('2024-01-15T10:00:00Z'),
        updated_at: new Date('2024-01-15T10:00:00Z'),
        owner_name: 'Sarah Johnson',
        owner_email: 'sarah.johnson@adaptalabs.com',
        sessions: []
    },
    {
        id: '2',
        type: 'poll',
        title: 'Feature Preference Survey',
        purpose_one_liner: 'Share your preferences for upcoming product features',
        description_optional: 'We want to understand which features are most important to our users.',
        product_optional: 'Mobile App',
        default_duration_minutes: 15,
        status: 'published',
        owner_user_id: 'demo-admin-456',
        external_link_optional: 'https://forms.google.com/example-poll',
        participant_type_required: 'any',
        participant_type_specific_details: null,
        created_at: new Date('2024-01-16T14:30:00Z'),
        updated_at: new Date('2024-01-16T14:30:00Z'),
        owner_name: 'Mike Chen',
        owner_email: 'mike.chen@adaptalabs.com',
        sessions: []
    },
    {
        id: '3',
        type: 'survey',
        title: 'Workplace Satisfaction Survey',
        purpose_one_liner: 'Help us understand workplace satisfaction and identify areas for improvement',
        description_optional: 'Your feedback is crucial for creating a better work environment for everyone.',
        product_optional: null,
        default_duration_minutes: 20,
        status: 'published',
        owner_user_id: 'demo-admin-456',
        external_link_optional: 'https://surveymonkey.com/example-survey',
        participant_type_required: 'internal',
        participant_type_specific_details: null,
        created_at: new Date('2024-01-17T09:15:00Z'),
        updated_at: new Date('2024-01-17T09:15:00Z'),
        owner_name: 'Sarah Johnson',
        owner_email: 'sarah.johnson@adaptalabs.com',
        sessions: []
    },
    {
        id: '4',
        type: 'test',
        title: 'Mobile App Beta Testing',
        purpose_one_liner: 'Test our new mobile app features before public release',
        description_optional: 'We need beta testers to try out new features and report any bugs or issues.',
        product_optional: 'Mobile App',
        default_duration_minutes: 60,
        status: 'draft',
        owner_user_id: 'demo-admin-456',
        external_link_optional: null,
        participant_type_required: 'external',
        created_at: new Date('2024-01-18T11:45:00Z'),
        updated_at: new Date('2024-01-18T11:45:00Z'),
        owner_name: 'Mike Chen',
        owner_email: 'mike.chen@adaptalabs.com',
        sessions: []
    },
    {
        id: '5',
        type: 'test',
        title: 'API Performance Testing',
        purpose_one_liner: 'Help us test API performance under various load conditions',
        description_optional: 'We need to test how our APIs perform under different load conditions.',
        product_optional: 'Backend Services',
        default_duration_minutes: 90,
        status: 'closed',
        owner_user_id: 'demo-admin-456',
        external_link_optional: null,
        participant_type_required: 'specific',
        participant_type_specific_details: 'Must have 3+ years experience with React and TypeScript. Experience with testing frameworks like Jest and Cypress preferred.',
        created_at: new Date('2024-01-10T08:00:00Z'),
        updated_at: new Date('2024-01-19T16:20:00Z'),
        owner_name: 'Sarah Johnson',
        owner_email: 'sarah.johnson@adaptalabs.com',
        sessions: []
    },
    {
        id: '6',
        type: 'test',
        title: 'Accessibility Testing',
        purpose_one_liner: 'Help us ensure our application is accessible to all users',
        description_optional: 'We need volunteers to test our application with screen readers and other accessibility tools.',
        product_optional: 'Web Application',
        default_duration_minutes: 30,
        status: 'published',
        owner_user_id: 'demo-admin-456',
        external_link_optional: null,
        participant_type_required: 'any',
        created_at: new Date('2024-01-20T13:00:00Z'),
        updated_at: new Date('2024-01-20T13:00:00Z'),
        owner_name: 'Mike Chen',
        owner_email: 'mike.chen@adaptalabs.com',
        sessions: []
    },
    {
        id: '7',
        type: 'poll',
        title: 'Design System Feedback',
        purpose_one_liner: 'Share your thoughts on our new design system components',
        description_optional: 'We are updating our design system and need your input on the new components.',
        product_optional: 'Design System',
        default_duration_minutes: 25,
        status: 'published',
        owner_user_id: 'demo-admin-456',
        external_link_optional: 'https://forms.google.com/design-feedback',
        created_at: new Date('2024-01-21T10:30:00Z'),
        updated_at: new Date('2024-01-21T10:30:00Z'),
        owner_name: 'Sarah Johnson',
        owner_email: 'sarah.johnson@adaptalabs.com',
        sessions: []
    },
    {
        id: '8',
        type: 'survey',
        title: 'Product Usage Analytics',
        purpose_one_liner: 'Help us understand how you use our products in your daily workflow',
        description_optional: 'Understanding usage patterns helps us prioritize features and improvements.',
        product_optional: 'Product Suite',
        default_duration_minutes: 35,
        status: 'published',
        owner_user_id: 'demo-admin-456',
        external_link_optional: 'https://surveymonkey.com/usage-analytics',
        created_at: new Date('2024-01-22T15:45:00Z'),
        updated_at: new Date('2024-01-22T15:45:00Z'),
        owner_name: 'Mike Chen',
        owner_email: 'mike.chen@adaptalabs.com',
        sessions: []
    },
    {
        id: '9',
        type: 'test',
        title: 'Security Testing',
        purpose_one_liner: 'Help us identify potential security vulnerabilities in our systems',
        description_optional: 'We need security-conscious users to help us test for potential vulnerabilities.',
        product_optional: 'Security Platform',
        default_duration_minutes: 75,
        status: 'published',
        owner_user_id: 'demo-admin-456',
        external_link_optional: null,
        created_at: new Date('2024-01-23T09:20:00Z'),
        updated_at: new Date('2024-01-23T09:20:00Z'),
        owner_name: 'Sarah Johnson',
        owner_email: 'sarah.johnson@adaptalabs.com',
        sessions: []
    },
    {
        id: '10',
        type: 'poll',
        title: 'Training Preferences',
        purpose_one_liner: 'Tell us about your preferred learning methods and training formats',
        description_optional: 'We want to improve our training programs based on your preferences.',
        product_optional: null,
        default_duration_minutes: 10,
        status: 'published',
        owner_user_id: 'demo-admin-456',
        external_link_optional: 'https://forms.google.com/training-preferences',
        created_at: new Date('2024-01-24T14:10:00Z'),
        updated_at: new Date('2024-01-24T14:10:00Z'),
        owner_name: 'Mike Chen',
        owner_email: 'mike.chen@adaptalabs.com',
        sessions: []
    },
    {
        id: '11',
        type: 'test',
        title: 'Cross-Platform Compatibility',
        purpose_one_liner: 'Test our application across different browsers and operating systems',
        description_optional: 'We need to ensure our application works consistently across various platforms.',
        product_optional: 'Web Application',
        default_duration_minutes: 50,
        status: 'published',
        owner_user_id: 'demo-admin-456',
        external_link_optional: null,
        created_at: new Date('2024-01-25T11:15:00Z'),
        updated_at: new Date('2024-01-25T11:15:00Z'),
        owner_name: 'Sarah Johnson',
        owner_email: 'sarah.johnson@adaptalabs.com',
        sessions: []
    },
    {
        id: '12',
        type: 'survey',
        title: 'Customer Support Experience',
        purpose_one_liner: 'Share your experience with our customer support team',
        description_optional: 'Help us improve our customer support by sharing your recent experiences.',
        product_optional: 'Support Platform',
        default_duration_minutes: 15,
        status: 'published',
        owner_user_id: 'demo-admin-456',
        external_link_optional: 'https://surveymonkey.com/support-experience',
        created_at: new Date('2024-01-26T16:30:00Z'),
        updated_at: new Date('2024-01-26T16:30:00Z'),
        owner_name: 'Mike Chen',
        owner_email: 'mike.chen@adaptalabs.com',
        sessions: []
    },
    {
        id: '13',
        type: 'question',
        title: 'What feature would improve your daily workflow?',
        purpose_one_liner: 'Share the one feature that would make the biggest difference in your daily work',
        description_optional: 'We want to understand what single feature would have the most impact on your productivity. Please be specific about how this feature would help you.',
        product_optional: 'Product Suite',
        default_duration_minutes: 5,
        status: 'published',
        owner_user_id: 'demo-admin-456',
        external_link_optional: null,
        created_at: new Date('2024-01-27T10:00:00Z'),
        updated_at: new Date('2024-01-27T10:00:00Z'),
        owner_name: 'Sarah Johnson',
        owner_email: 'sarah.johnson@adaptalabs.com',
        sessions: []
    },
    {
        id: '14',
        type: 'question',
        title: 'What is your biggest challenge with our current tools?',
        purpose_one_liner: 'Tell us about the main obstacle you face when using our products',
        description_optional: 'Help us identify the most significant pain points in our current toolset. Your input will directly influence our product roadmap.',
        product_optional: 'Development Tools',
        default_duration_minutes: 3,
        status: 'published',
        owner_user_id: 'demo-admin-456',
        external_link_optional: null,
        created_at: new Date('2024-01-28T14:15:00Z'),
        updated_at: new Date('2024-01-28T14:15:00Z'),
        owner_name: 'Mike Chen',
        owner_email: 'mike.chen@adaptalabs.com',
        sessions: []
    }
];
// Export the original static data for reference
exports.mockOpportunities = dynamicMockOpportunities;
const getMockOpportunities = (filters) => {
    let filtered = [...dynamicMockOpportunities];
    if (filters?.type) {
        filtered = filtered.filter(opp => opp.type === filters.type);
    }
    if (filters?.q) {
        const query = filters.q.toLowerCase();
        filtered = filtered.filter(opp => opp.title.toLowerCase().includes(query) ||
            opp.purpose_one_liner.toLowerCase().includes(query));
    }
    if (filters?.status) {
        filtered = filtered.filter(opp => opp.status === filters.status);
    }
    return filtered;
};
exports.getMockOpportunities = getMockOpportunities;
const getMockOpportunity = (id) => {
    return dynamicMockOpportunities.find(opp => opp.id === id);
};
exports.getMockOpportunity = getMockOpportunity;
// Function to add a new opportunity to the dynamic mock data
const addMockOpportunity = (opportunity) => {
    dynamicMockOpportunities.unshift(opportunity);
};
exports.addMockOpportunity = addMockOpportunity;
// Function to update an opportunity in the dynamic mock data
const updateMockOpportunity = (id, updates) => {
    const index = dynamicMockOpportunities.findIndex(opp => opp.id === id);
    if (index !== -1) {
        dynamicMockOpportunities[index] = { ...dynamicMockOpportunities[index], ...updates };
        return dynamicMockOpportunities[index];
    }
    return null;
};
exports.updateMockOpportunity = updateMockOpportunity;
// Function to delete an opportunity from the dynamic mock data
const deleteMockOpportunity = (id) => {
    const index = dynamicMockOpportunities.findIndex(opp => opp.id === id);
    if (index !== -1) {
        dynamicMockOpportunities.splice(index, 1);
        return true;
    }
    return false;
};
exports.deleteMockOpportunity = deleteMockOpportunity;
//# sourceMappingURL=mock-data.js.map