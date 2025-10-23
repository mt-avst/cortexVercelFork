"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteMockOpportunity = exports.updateMockOpportunity = exports.addMockOpportunity = exports.getMockOpportunity = exports.getMockOpportunities = exports.mockOpportunities = void 0;
// Mock data service for development when database is not available
let dynamicMockOpportunities = [];
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