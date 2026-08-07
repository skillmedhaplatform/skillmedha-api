module.exports = {
    root: ` 
    scalar JSON


        type PageInfo {
            hasNextPage: Boolean!
        }

    union QuestionType = Questions | ComprehensionQuestions
    
          type Test {
              _id: String
              courseName: String
              title : String
              longDescription : String
              shortDescription : String
              access : JSON
              startPage : JSON
              grading : JSON
              logo : String
              pricing : JSON
              enrolledStudents : [Student]
              blockedStudents : [Student]
              time : JSON
              status : String
              testType:String
              category:[Category]
              language : [Language]
              createdAt : String
              updatedAt: String
              thumbnail : String
              contentMedia : JSON
              content : JSON
              createdBy : String
              totalMarks : String
              totalQuestions : String
              totalTime : String
              startDate : String
              endDate : String
              questions : [QuestionType]
              honestRespondent : JSON
              snapShotTechnology : String
              facialRecognitionTechnology: String
              testEvaluationType : String
              resultsConfig: JSON
              attemptGeneration: Int
          }   
          
            type TestRes {
                tests: [Test],
                pageInfo : PageInfo
            }
    
          union TestUnion = Test | err

      `,
  
    query: `
              type Query {
                  tests(cursor: ID, limit: Int,category:String,status:String,language:String,origin:String,testEvaluationType : String,studentId:String): TestRes
                  test(id: String): TestUnion
              
          }`,

  };