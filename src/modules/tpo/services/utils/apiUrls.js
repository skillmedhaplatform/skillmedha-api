const isProd = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "prod";

// If API_URL is provided in .env, use it.
// Otherwise, in production use the live Azure URL. In local development use localhost.
const graphqlUrl = process.env.API_URL 
  ? `${process.env.API_URL}/gql`
  : isProd
    ? "https://smp-assessmentgqlapi-live.livelyglacier-cf8dd916.centralindia.azurecontainerapps.io"
    : "http://localhost:4000/gql";

module.exports = { graphqlUrl };