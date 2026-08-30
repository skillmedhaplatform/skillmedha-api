const { ObjectId } = require("mongodb");
const { companyTests } = require("../../../shared/db/connection").getGlobalCollections();
const { connectTodb } = require("../../../shared/db/connection");

module.exports.createCompanyTest = async (req, res) => {
  try {
    const { title, initials, color, hiringType, patternName, sections = [] } = req.body;

    if (!title) {
      return res.status(400).json({ err: "Company title is required" });
    }

    const testPayload = {
      title,
      initials,
      color,
      hiringType,
      patternName,
      sections,
      createdAt: new Date(),
      createdBy: req.userID,
    };

    const result = await companyTests.insertOne(testPayload);
    
    // Return the created object so the frontend can add it to the state
    res.status(201).json({
      message: "Company test added successfully",
      data: { _id: result.insertedId, ...testPayload },
    });
  } catch (error) {
    console.error("Error in createCompanyTest:", error);
    res.status(500).json({ err: "Internal server error" });
  }
};

module.exports.getCompanyTests = async (req, res) => {
  try {
    const tests = await companyTests.find({}).sort({ createdAt: -1 }).toArray();

    const { getSharedMongoClient } = require("../../../shared/db/connection");
    const sharedClient = await getSharedMongoClient();
    const masterDbName = process.env.SHARED_DB_NAME || "KSquare";
    const masterDb = sharedClient.db(masterDbName);
    const questions = masterDb.collection("questions");
    const testIds = tests.map(t => t._id);
    
    // Fetch relevant fields for all questions linked to these tests
    const allQuestions = await questions
      .find({ subjectId: { $in: testIds }, isTest: true })
      .project({ subjectId: 1, questionType: 1 })
      .toArray();

    // Group and calculate stats
    const testStats = {};
    for (const q of allQuestions) {
      const tid = q.subjectId.toString();
      if (!testStats[tid]) {
        testStats[tid] = { questionCount: 0, timeLimitRaw: 0 };
      }
      testStats[tid].questionCount += 1;
      
      const type = (q.questionType || "").toLowerCase();
      // Rules: Coding question = 25 mins. Other questions = 0.75 mins (45 seconds)
      if (type.includes("coding")) {
        testStats[tid].timeLimitRaw += 25;
      } else {
        testStats[tid].timeLimitRaw += 0.75;
      }
    }

    // Attach calculated stats to tests
    const finalTests = tests.map(t => {
      const stats = testStats[t._id.toString()] || { questionCount: 0, timeLimitRaw: 0 };
      return {
        ...t,
        questionCount: stats.questionCount,
        timeLimit: Math.ceil(stats.timeLimitRaw)
      };
    });

    res.status(200).json({ data: finalTests });
  } catch (error) {
    console.error("Error in getCompanyTests:", error);
    res.status(500).json({ err: "Internal server error" });
  }
};

module.exports.deleteCompanyTest = async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ err: "Invalid company test ID" });
    }

    const result = await companyTests.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ err: "Company test not found" });
    }

    res.status(200).json({ message: "Company test deleted successfully" });
  } catch (error) {
    console.error("Error in deleteCompanyTest:", error);
    res.status(500).json({ err: "Internal server error" });
  }
};
