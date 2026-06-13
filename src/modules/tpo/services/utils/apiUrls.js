const graphqlUrl = process.env.GRAPHQL_URL || `http://localhost:${process.env.PORT || 5000}/gql`;

module.exports = { graphqlUrl };