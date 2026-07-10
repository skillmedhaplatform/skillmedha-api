const typeDefs = {
    root: `
            scalar JSON
    
            type Progress{
                _id : String
                testId : String
                response : JSON
                flagged : JSON
                marked: JSON
                studentId : String
                scoreData: JSON
                capturedImage : String
                testDetails : Test
                studentDetails : Student
                studentData : JSON
                createdAt : String
                studentActivity: JSON
            }
    
        
            union ProgressUnion = Progress | err
        `,

    query: `
            type Query {
                progress(testEvaluationType : String , limit : Int , testId : String) : [Progress]
                progressLimit(cursor: ID, limit: Int, skip: Int) : [Progress]
                progressTotal : Int
                progresses (_id:String): ProgressUnion
            }
        `,

};

module.exports = typeDefs;