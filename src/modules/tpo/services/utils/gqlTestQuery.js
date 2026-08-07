const SingleTestQuery = `query Test($testId: String) {
  test(id: $testId) {
    ... on Test {
      _id
      testEvaluationType
      questions {
        ... on Questions {
          _id
          questionType
          questionContent
          sno
          questionScore
          scoreSettings
          answer
          resources
        }
        ... on ComprehensionQuestions {
          _id
          questionType
          questionContentArr {
            _id
            questionType
            questionContent
            sno
            questionScore
            scoreSettings
            answer
            resources
          }
          comprehensionText
          sno
          questionScore
          resources
      }
      attemptGeneration
    }
  }
}`;

module.exports = SingleTestQuery;
