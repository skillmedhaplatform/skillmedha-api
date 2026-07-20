// src/services/dashboardService.js
const {
  getKSquareDB,
  getGlobalDB,
  getOrgDB,
  getResourcesDB,
} = require("./dashboardDatabase");
const { ObjectId } = require("mongodb");

class DashboardService {
  // ==================== GET ALL ORGANIZATIONS ====================
  async getOrganizations() {
    try {
      const globalDB = getGlobalDB();
      console.log("📊 Fetching organizations from globalDB...");

      const organizations = await globalDB
        .collection("organizations")
        .find({})
        .toArray();
      console.log(`✅ Found ${organizations.length} organizations`);

      // Enhance with additional stats
      const enhancedOrgs = await Promise.all(
        organizations.map(async (org) => {
          console.log(
            `\n🔍 Processing: ${org.orgName} (${org.orgId}) - Type: ${org.type}`
          );
          const stats = await this.getOrgStats(org.orgId, org.type);
          console.log(`   Stats:`, stats);

          return {
            ...org,
            stats,
          };
        })
      );

      console.log("\n✅ All organizations processed successfully\n");
      return enhancedOrgs;
    } catch (error) {
      console.error("❌ Error in getOrganizations:", error);
      throw new Error(`Error fetching organizations: ${error.message}`);
    }
  }

  // ==================== GET ORG STATS ====================
  async getOrgStats(orgId, orgType) {
    try {
      const stats = {
        tpoCount: 0,
        departmentCount: 0,
        studentCount: 0,
        jobCount: 0,
        hrCount: 0,
        courseCount: 0,
        internshipCount: 0,
        aiUsage: {
          totalTokens: 0,
          totalRequests: 0,
          byType: {},
        },
      };

      try {
        const resourcesDB = getResourcesDB();

        const aiUsageStats = await resourcesDB
          .collection("ai_usage")
          .aggregate([
            { $match: { orgId: orgId } },
            {
              $group: {
                _id: "$type",
                totalTokens: { $sum: "$totalTokens" },
                requestCount: { $sum: 1 },
              },
            },
          ])
          .toArray();

        // Process AI usage by type
        aiUsageStats.forEach((item) => {
          stats.aiUsage.byType[item._id] = {
            totalTokens: item.totalTokens,
            requestCount: item.requestCount,
          };
          stats.aiUsage.totalTokens += item.totalTokens;
          stats.aiUsage.totalRequests += item.requestCount;
        });

        console.log(
          ` AI Usage: ${stats.aiUsage.totalRequests} requests, ${stats.aiUsage.totalTokens} tokens`
        );
      } catch (aiError) {
        console.warn(
          ` ⚠️ Could not fetch AI usage for ${orgId}:`,
          aiError.message
        );
      }
      if (orgType === "college") {
        try {
          const orgDB = getOrgDB(orgId);

          // Count TPOs
          const tpoCount = await orgDB.collection("tpo").countDocuments();
          stats.tpoCount = tpoCount;

          // Count Departments
          const departmentCount = await orgDB
            .collection("department")
            .countDocuments();
          stats.departmentCount = departmentCount;

          // Count Students
          const studentCount = await orgDB
            .collection("student")
            .countDocuments();
          stats.studentCount = studentCount;

          // Count Assigned Courses
          const courseCount = await orgDB
            .collection("assignedCourses")
            .countDocuments();
          stats.courseCount = courseCount;

          // Count Assigned Internships
          const internshipCount = await orgDB
            .collection("assignedInternships")
            .countDocuments();
          stats.internshipCount = internshipCount;

          // Count Jobs posted by college
          try {
            const jobsInCollegeDB = await orgDB
              .collection("job")
              .countDocuments();
            stats.jobCount = jobsInCollegeDB;
          } catch (e) {
            // No jobs collection
          }

          console.log(
            `   ✓ College stats: TPOs=${tpoCount}, Depts=${departmentCount}, Students=${studentCount}, Jobs=${stats.jobCount}, Courses=${courseCount}, Internships=${internshipCount}`
          );
        } catch (orgDbError) {
          console.warn(
            `   ⚠️ Could not fetch college stats for ${orgId}:`,
            orgDbError.message
          );
        }
      } else if (orgType === "company") {
        try {
          const kSquareDB = getKSquareDB();

          // Try to count jobs from KSquare DB
          const jobsByProfileId = await kSquareDB
            .collection("job")
            .countDocuments({ profileId: orgId });

          const jobsByOrgId = await kSquareDB
            .collection("job")
            .countDocuments({ orgId: orgId });

          let jobCount = jobsByProfileId || jobsByOrgId;

          // Also check company's own database for jobs
          try {
            const companyDB = getOrgDB(orgId);
            const jobsInCompanyDB = await companyDB
              .collection("job")
              .countDocuments();
            jobCount += jobsInCompanyDB;
          } catch (e) {
            // No jobs in company DB
          }

          stats.jobCount = jobCount;

          // Count HRs from company-specific database
          // ALL users in company DB are HRs
          try {
            const companyDB = getOrgDB(orgId);
            const hrCount = await companyDB
              .collection("users")
              .countDocuments();
            stats.hrCount = hrCount;
          } catch (hrError) {
            console.warn(
              `   ⚠️ Could not count HRs for ${orgId}:`,
              hrError.message
            );
          }

          console.log(
            `   ✓ Company stats: Jobs=${stats.jobCount}, HRs=${stats.hrCount}`
          );
        } catch (companyError) {
          console.warn(
            `   ⚠️ Could not fetch company stats for ${orgId}:`,
            companyError.message
          );
        }
      }

      return stats;
    } catch (error) {
      console.error(`❌ Error getting stats for ${orgId}:`, error);
      return {
        tpoCount: 0,
        departmentCount: 0,
        studentCount: 0,
        jobCount: 0,
        hrCount: 0,
        courseCount: 0,
        internshipCount: 0,
      };
    }
  }

  // ==================== GET ORGANIZATION BY ID ====================
  async getOrganizationById(orgId) {
    try {
      console.log(`\n🔍 Fetching organization: ${orgId}`);

      const globalDB = getGlobalDB();
      const org = await globalDB.collection("organizations").findOne({ orgId });

      if (!org) {
        throw new Error("Organization not found");
      }

      console.log(`✅ Found: ${org.orgName} (${org.type})`);

      const stats = await this.getOrgStats(org.orgId, org.type);

      return {
        ...org,
        stats,
      };
    } catch (error) {
      console.error("❌ Error fetching organization:", error);
      throw new Error(`Error fetching organization: ${error.message}`);
    }
  }

  // ==================== GET DEPARTMENTS BY ORG ====================
  async getDepartmentsByOrg(orgId) {
    try {
      console.log(`\n🔍 Fetching departments for: ${orgId}`);

      const orgDB = getOrgDB(orgId);
      const departments = await orgDB
        .collection("department")
        .find({})
        .toArray();

      console.log(`✅ Found ${departments.length} departments`);

      // Count students in each department
      const departmentsWithStats = departments.map((dept) => {
        const studentCount = dept.students ? dept.students.length : 0;
        console.log(`   - ${dept.title}: ${studentCount} students`);

        return {
          ...dept,
          studentCount,
        };
      });

      return departmentsWithStats;
    } catch (error) {
      console.error("❌ Error fetching departments:", error);
      throw new Error(`Error fetching departments: ${error.message}`);
    }
  }

  // ==================== GET STUDENTS BY DEPARTMENT ====================
  async getStudentsByDepartment(
    orgId,
    departmentId,
    page = 1,
    limit = 10,
    search = ""
  ) {
    try {
      console.log(
        `\n🔍 Fetching students for dept: ${departmentId} in org: ${orgId}`
      );
      console.log(`   Page: ${page}, Limit: ${limit}, Search: "${search}"`);

      const orgDB = getOrgDB(orgId);
      const skip = (page - 1) * limit;

      // Get department with ObjectId
      let deptObjectId;
      try {
        deptObjectId = new ObjectId(departmentId);
      } catch (e) {
        deptObjectId = departmentId;
      }

      const department = await orgDB.collection("department").findOne({
        _id: deptObjectId,
      });

      if (!department) {
        throw new Error("Department not found");
      }

      console.log(`✅ Found department: ${department.title}`);

      // Build query for students
      let query = {};

      // If department has student IDs array
      if (department.students && department.students.length > 0) {
        const studentIds = department.students.map((id) => {
          try {
            return new ObjectId(id);
          } catch (e) {
            return id;
          }
        });

        query._id = { $in: studentIds };
      }

      // Add search filter
      if (search) {
        query.$or = [
          { userName: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
          { firstName: { $regex: search, $options: "i" } },
          { lastName: { $regex: search, $options: "i" } },
        ];
      }

      console.log(`   Query:`, JSON.stringify(query, null, 2));

      // Get students with pagination
      const students = await orgDB
        .collection("student")
        .find(query)
        .skip(skip)
        .limit(limit)
        .toArray();

      const totalCount = await orgDB
        .collection("student")
        .countDocuments(query);

      console.log(
        `✅ Found ${students.length} students (total: ${totalCount})`
      );

      const enhancedStudents = await Promise.all(
        students.map(async (student) => {
          const aiUsage = await this.getStudentAiUsage(student._id.toString());
          return {
            ...student,
            aiUsage,
          };
        })
      );

      return {
        orgId,
        departmentId,
        departmentData: department,
        students: enhancedStudents,
        count: enhancedStudents.length,
        totalCount,
        currentPage: page,
        totalPages: Math.ceil(totalCount / limit),
        search: search || null,
      };
    } catch (error) {
      console.error("❌ Error fetching students:", error);
      throw new Error(`Error fetching students: ${error.message}`);
    }
  }

  // ==================== GET DASHBOARD STATS ====================
  async getDashboardStats() {
    try {
      const globalDB = getGlobalDB();
      const kSquareDB = getKSquareDB();
      const resourcesDB = getResourcesDB();

      // Count organizations
      const totalOrgs = await globalDB
        .collection("organizations")
        .countDocuments({ active: true });
      const totalColleges = await globalDB
        .collection("organizations")
        .countDocuments({ type: "college", active: true });
      const totalCompanies = await globalDB
        .collection("organizations")
        .countDocuments({ type: "company", active: true });
      const activeOrgs = await globalDB
        .collection("organizations")
        .countDocuments({ active: true });

      const allOrganizations = await globalDB
        .collection("organizations")
        .find({ active: true })
        .toArray();

      let totalJobs = 0;

      for (const org of allOrganizations) {
        if (org.type === "company") {
          try {
            // Check KSquare DB for jobs linked to this company
            const jobsByProfileId = await kSquareDB
              .collection("job")
              .countDocuments({ profileId: org.orgId });

            const jobsByOrgId = await kSquareDB
              .collection("job")
              .countDocuments({ orgId: org.orgId });

            let jobCount = jobsByProfileId || jobsByOrgId;

            // Also check company's own database for jobs
            try {
              const companyDB = getOrgDB(org.orgId);
              const jobsInCompanyDB = await companyDB
                .collection("job")
                .countDocuments();
              jobCount += jobsInCompanyDB;
            } catch (e) {
              // No job collection
            }
            
            try {
              const companyDB = getOrgDB(org.orgId);
              const jobsInJobsCollection = await companyDB
                .collection("jobs")
                .countDocuments();
              jobCount += jobsInJobsCollection;
            } catch (e) {
              // No jobs collection
            }

            totalJobs += jobCount;
          } catch (error) {
            // Silent fail for organizations without job collections
          }
        }
      }

      // Count assigned jobs
      const totalAssignedJobs = await kSquareDB
        .collection("assignedJob")
        .countDocuments();

      // Get all college organizations
      const colleges = await globalDB
        .collection("organizations")
        .find({ type: "college", active: true })
        .toArray();

      let totalStudents = 0;
      let totalTPOs = 0;
      let totalDepartments = 0;
      let totalCourses = 0;
      let totalInternships = 0;

      for (const college of colleges) {
        try {
          const orgDB = getOrgDB(college.orgId);

          const studentCount = await orgDB
            .collection("student")
            .countDocuments();
          const tpoCount = await orgDB.collection("tpo").countDocuments();
          const departmentCount = await orgDB
            .collection("department")
            .countDocuments();
          const courseCount = await orgDB
            .collection("assignedCourses")
            .countDocuments();
          const internshipCount = await orgDB
            .collection("assignedInternships")
            .countDocuments();

          totalStudents += studentCount;
          totalTPOs += tpoCount;
          totalDepartments += departmentCount;
          totalCourses += courseCount;
          totalInternships += internshipCount;
        } catch (error) {
          console.warn(
            `      ⚠️ Could not count for ${college.orgId}:`,
            error.message
          );
        }
      }

      // Get all company organizations to count HRs (ALL users in company DB are HRs)
      const companies = await globalDB
        .collection("organizations")
        .find({ type: "company", active: true })
        .toArray();

      let totalHRs = 0;

      for (const company of companies) {
        try {
          const companyDB = getOrgDB(company.orgId);

          // Count ALL users (all users in company DB are HRs)
          const hrCount = await companyDB.collection("users").countDocuments();

          totalHRs += hrCount;
        } catch (error) {
          console.warn(
            `      ⚠️ Could not count HRs for ${company.orgId}:`,
            error.message
          );
        }
      }

      // NEW: Count AI Usage Stats
      let totalAiTokens = 0;
      let totalAiRequests = 0;
      let aiUsageByType = {};

      try {
        const aiUsageStats = await resourcesDB
          .collection("ai_usage")
          .aggregate([
            {
              $group: {
                _id: "$type",
                totalTokens: { $sum: "$totalTokens" },
                promptTokens: { $sum: "$promptTokens" },
                completionTokens: { $sum: "$completionTokens" },
                requestCount: { $sum: 1 },
                successCount: {
                  $sum: { $cond: [{ $eq: ["$status", "success"] }, 1, 0] },
                },
              },
            },
          ])
          .toArray();

        aiUsageStats.forEach((item) => {
          aiUsageByType[item._id] = {
            totalTokens: item.totalTokens,
            promptTokens: item.promptTokens,
            completionTokens: item.completionTokens,
            requestCount: item.requestCount,
            successCount: item.successCount,
            successRate:
              ((item.successCount / item.requestCount) * 100).toFixed(2) + "%",
          };
          totalAiTokens += item.totalTokens;
          totalAiRequests += item.requestCount;
        });
      } catch (aiError) {
        console.warn(" ⚠️ Could not fetch AI usage stats:", aiError.message);
      }

      const result = {
        totalOrganizations: totalOrgs,
        totalColleges,
        totalCompanies,
        activeOrganizations: activeOrgs,
        totalStudents,
        totalTPOs,
        totalHRs,
        totalDepartments,
        totalJobs,
        totalAssignedJobs,
        totalCourses,
        totalInternships,
        // NEW: Add AI usage stats
        aiUsage: {
          totalTokens: totalAiTokens,
          totalRequests: totalAiRequests,
          byType: aiUsageByType,
        },
      };

      return result;
    } catch (error) {
      console.error("\n❌ Error fetching dashboard stats:", error);
      throw new Error(`Error fetching dashboard stats: ${error.message}`);
    }
  }

  // src/services/dashboardService.js

  // ==================== GET GROWTH STATS ====================
  async getGrowthStats(period = "6months") {
    try {
      console.log(`\n📈 Fetching growth stats for period: ${period}`);

      const globalDB = getGlobalDB();
      const kSquareDB = getKSquareDB();

      // Calculate date range
      const now = new Date();
      const months = period === "6months" ? 6 : period === "1year" ? 12 : 3;
      const startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - months);

      console.log(
        `   Date range: ${startDate.toISOString()} to ${now.toISOString()}`
      );
      console.log(
        `   Timestamp range: ${startDate.getTime()} to ${now.getTime()}`
      );

      // Get all organizations
      const allOrganizations = await globalDB
        .collection("organizations")
        .find({})
        .toArray();

      // Check job structure
      console.log("\n🔍 Checking job document structure...");
      const sampleJob = await kSquareDB.collection("job").findOne({});
      if (sampleJob) {
        console.log(
          "Sample job createdAt:",
          sampleJob.createdAt,
          "Type:",
          typeof sampleJob.createdAt
        );
        console.log("Sample job startDate:", sampleJob.startDate);
      }

      // Generate monthly data points
      const dataPoints = [];

      for (let i = 0; i <= months; i++) {
        const pointDate = new Date(startDate);
        pointDate.setMonth(pointDate.getMonth() + i);
        const pointTimestamp = pointDate.getTime();

        console.log(
          `\n📅 Processing: ${pointDate.toLocaleDateString()} (${pointTimestamp})`
        );

        let studentsCount = 0;
        let jobsCount = 0;
        let coursesCount = 0;
        let internshipsCount = 0;

        // Count from all organizations
        for (const org of allOrganizations) {
          if (org.type === "college") {
            try {
              const orgDB = getOrgDB(org.orgId);

              // Count students
              try {
                // Try different date formats
                const students = await orgDB
                  .collection("student")
                  .countDocuments({
                    $or: [
                      { createdAt: { $lte: pointTimestamp } }, // Unix timestamp
                      { createdAt: { $lte: pointDate } }, // Date object
                      { created_at: { $lte: pointTimestamp } },
                      { created_at: { $lte: pointDate } },
                    ],
                  });
                studentsCount += students;
              } catch (e) {
                // Fallback: count all
                const allStudents = await orgDB
                  .collection("student")
                  .countDocuments();
                studentsCount += allStudents;
              }

              // Count courses
              try {
                const courses = await orgDB
                  .collection("assignedCourses")
                  .countDocuments({
                    $or: [
                      { createdAt: { $lte: pointTimestamp } },
                      { createdAt: { $lte: pointDate } },
                      { created_at: { $lte: pointTimestamp } },
                      { created_at: { $lte: pointDate } },
                    ],
                  });
                coursesCount += courses;
              } catch (e) {
                const allCourses = await orgDB
                  .collection("assignedCourses")
                  .countDocuments();
                coursesCount += allCourses;
              }

              // Count internships
              try {
                const internships = await orgDB
                  .collection("assignedInternships")
                  .countDocuments({
                    $or: [
                      { createdAt: { $lte: pointTimestamp } },
                      { createdAt: { $lte: pointDate } },
                      { created_at: { $lte: pointTimestamp } },
                      { created_at: { $lte: pointDate } },
                    ],
                  });
                internshipsCount += internships;
              } catch (e) {
                const allInternships = await orgDB
                  .collection("assignedInternships")
                  .countDocuments();
                internshipsCount += allInternships;
              }

              // Count jobs in college DB
              try {
                const jobsInCollegeDB = await orgDB
                  .collection("job")
                  .countDocuments({
                    $or: [
                      { createdAt: { $lte: pointTimestamp } }, // Unix timestamp
                      { createdAt: { $lte: pointDate } }, // Date object
                      { created_at: { $lte: pointTimestamp } },
                      { created_at: { $lte: pointDate } },
                    ],
                  });
                jobsCount += jobsInCollegeDB;
              } catch (e) {
                // No jobs collection or error
              }
            } catch (error) {
              console.warn(
                `   ⚠️ Error for college ${org.orgId}:`,
                error.message
              );
            }
          } else if (org.type === "company") {
            try {
              const companyDB = getOrgDB(org.orgId);

              // Count jobs in company DB
              try {
                const jobsInCompanyDB = await companyDB
                  .collection("job")
                  .countDocuments({
                    $or: [
                      { createdAt: { $lte: pointTimestamp } },
                      { createdAt: { $lte: pointDate } },
                      { created_at: { $lte: pointTimestamp } },
                      { created_at: { $lte: pointDate } },
                    ],
                  });
                jobsCount += jobsInCompanyDB;
                if (jobsInCompanyDB > 0) {
                  console.log(
                    `   Company ${org.orgName}: ${jobsInCompanyDB} jobs`
                  );
                }
              } catch (e) {
                // No jobs
              }
            } catch (error) {
              console.warn(
                `   ⚠️ Error for company ${org.orgId}:`,
                error.message
              );
            }
          }
        }

        // Count jobs from KSquare DB - THIS IS KEY
        try {
          // Try Unix timestamp (since your data shows: "createdAt": 1755066065798)
          const jobsInKSquare = await kSquareDB
            .collection("job")
            .countDocuments({
              $or: [
                { createdAt: { $lte: pointTimestamp } }, // Unix timestamp as number
                { createdAt: { $lte: pointDate } }, // Date object
                { created_at: { $lte: pointTimestamp } },
                { created_at: { $lte: pointDate } },
              ],
            });

          console.log(
            `   ✓ KSquare jobs at ${pointDate.toLocaleDateString()}: ${jobsInKSquare}`
          );
          jobsCount += jobsInKSquare;

          // Debug: Show total jobs in KSquare for reference
          if (i === 0) {
            const totalJobsInKSquare = await kSquareDB
              .collection("job")
              .countDocuments();
            console.log(
              `   📊 Total jobs in KSquare DB: ${totalJobsInKSquare}`
            );
          }
        } catch (e) {
          console.warn(`   ⚠️ Error counting KSquare jobs:`, e.message);
        }

        dataPoints.push({
          date: pointDate.toISOString().split("T")[0],
          month: pointDate.toLocaleDateString("en-US", {
            month: "short",
            year: "numeric",
          }),
          students: studentsCount,
          jobs: jobsCount,
          courses: coursesCount,
          internships: internshipsCount,
        });

        console.log(
          `   ✅ Totals: Students=${studentsCount}, Jobs=${jobsCount}, Courses=${coursesCount}, Internships=${internshipsCount}`
        );
      }

      console.log(`\n✅ Generated ${dataPoints.length} data points\n`);

      return {
        period,
        dataPoints,
      };
    } catch (error) {
      console.error("❌ Error fetching growth stats:", error);
      throw new Error(`Error fetching growth stats: ${error.message}`);
    }
  }

  async getStudentAiUsage(userId) {
    try {
      const resourcesDB = getResourcesDB();

      const aiUsageStats = await resourcesDB
        .collection("ai_usage")
        .aggregate([
          { $match: { userId: userId } },
          {
            $group: {
              _id: "$type",
              totalTokens: { $sum: "$totalTokens" },
              promptTokens: { $sum: "$promptTokens" },
              completionTokens: { $sum: "$completionTokens" },
              requestCount: { $sum: 1 },
              successCount: {
                $sum: { $cond: [{ $eq: ["$status", "success"] }, 1, 0] },
              },
            },
          },
        ])
        .toArray();

      const result = {
        totalTokens: 0,
        totalRequests: 0,
        byType: {},
      };

      aiUsageStats.forEach((item) => {
        result.byType[item._id] = {
          totalTokens: item.totalTokens,
          promptTokens: item.promptTokens,
          completionTokens: item.completionTokens,
          requestCount: item.requestCount,
          successCount: item.successCount,
        };
        result.totalTokens += item.totalTokens;
        result.totalRequests += item.requestCount;
      });

      return result;
    } catch (error) {
      console.error(`❌ Error getting AI usage for user ${userId}:`, error);
      return {
        totalTokens: 0,
        totalRequests: 0,
        byType: {},
      };
    }
  }
  async getAiUsageGrowth(period = "6months") {
    try {
      console.log(`\n🤖 Fetching AI usage growth for period: ${period}`);
      const resourcesDB = getResourcesDB();

      // Calculate date range
      const now = new Date();
      const months = period === "6months" ? 6 : period === "1year" ? 12 : 3;
      const startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - months);

      console.log(
        ` Date range: ${startDate.toISOString()} to ${now.toISOString()}`
      );

      // Generate monthly data points
      const dataPoints = [];

      for (let i = 0; i <= months; i++) {
        const pointDate = new Date(startDate);
        pointDate.setMonth(pointDate.getMonth() + i);

        const nextPointDate = new Date(pointDate);
        nextPointDate.setMonth(nextPointDate.getMonth() + 1);

        console.log(`\n📅 Processing: ${pointDate.toLocaleDateString()}`);

        // Get AI usage for this month
        const monthlyStats = await resourcesDB
          .collection("ai_usage")
          .aggregate([
            {
              $match: {
                createdAt: {
                  $gte: pointDate,
                  $lt: nextPointDate,
                },
              },
            },
            {
              $group: {
                _id: "$type",
                totalTokens: { $sum: "$totalTokens" },
                promptTokens: { $sum: "$promptTokens" },
                completionTokens: { $sum: "$completionTokens" },
                requestCount: { $sum: 1 },
                successCount: {
                  $sum: { $cond: [{ $eq: ["$status", "success"] }, 1, 0] },
                },
              },
            },
          ])
          .toArray();

        let monthTotalTokens = 0;
        let monthTotalRequests = 0;
        const byType = {};

        monthlyStats.forEach((item) => {
          byType[item._id] = {
            totalTokens: item.totalTokens,
            requestCount: item.requestCount,
            successCount: item.successCount,
          };
          monthTotalTokens += item.totalTokens;
          monthTotalRequests += item.requestCount;
        });

        dataPoints.push({
          date: pointDate.toISOString().split("T")[0],
          month: pointDate.toLocaleDateString("en-US", {
            month: "short",
            year: "numeric",
          }),
          totalTokens: monthTotalTokens,
          totalRequests: monthTotalRequests,
          byType,
        });

        console.log(
          ` ✅ Month Totals: Tokens=${monthTotalTokens}, Requests=${monthTotalRequests}`
        );
      }

      // Calculate change rates
      const changeRates = this.calculateChangeRates(dataPoints);

      console.log(`\n✅ Generated ${dataPoints.length} AI usage data points\n`);

      return {
        period,
        dataPoints,
        changeRates,
      };
    } catch (error) {
      console.error("❌ Error fetching AI usage growth:", error);
      throw new Error(`Error fetching AI usage growth: ${error.message}`);
    }
  }

  // ==================== CALCULATE CHANGE RATES ====================
  calculateChangeRates(dataPoints) {
    if (dataPoints.length < 2) {
      return {
        tokenChangeRate: "0%",
        requestChangeRate: "0%",
        overallTrend: "insufficient data",
      };
    }

    // Compare last month to previous month
    const lastMonth = dataPoints[dataPoints.length - 1];
    const previousMonth = dataPoints[dataPoints.length - 2];

    const tokenChange = lastMonth.totalTokens - previousMonth.totalTokens;
    const tokenChangeRate =
      previousMonth.totalTokens > 0
        ? ((tokenChange / previousMonth.totalTokens) * 100).toFixed(2)
        : "0";

    const requestChange = lastMonth.totalRequests - previousMonth.totalRequests;
    const requestChangeRate =
      previousMonth.totalRequests > 0
        ? ((requestChange / previousMonth.totalRequests) * 100).toFixed(2)
        : "0";

    // Calculate overall trend (first month vs last month)
    const firstMonth = dataPoints[0];
    const overallTokenChange = lastMonth.totalTokens - firstMonth.totalTokens;
    const overallTokenChangeRate =
      firstMonth.totalTokens > 0
        ? ((overallTokenChange / firstMonth.totalTokens) * 100).toFixed(2)
        : "0";

    return {
      monthOverMonth: {
        tokenChange,
        tokenChangeRate: tokenChangeRate + "%",
        requestChange,
        requestChangeRate: requestChangeRate + "%",
      },
      overall: {
        tokenChange: overallTokenChange,
        tokenChangeRate: overallTokenChangeRate + "%",
        trend:
          parseFloat(overallTokenChangeRate) > 0
            ? "increasing"
            : parseFloat(overallTokenChangeRate) < 0
            ? "decreasing"
            : "stable",
      },
    };
  }

  // ==================== GET COURSE ANALYTICS ====================
  // ==================== GET COURSE ANALYTICS ====================
  // ==================== GET COURSE ANALYTICS ====================
  async getCourseAnalytics() {
    try {
      console.log("\n📊 ========== FETCHING COURSE ANALYTICS ==========");
      const globalDB = getGlobalDB();
      const kSquareDB = getKSquareDB(); // NEW: Get KSquareDB connection
      const paymentCollection = globalDB.collection("payment");

      // 1. Fetch Course Metadata (Names) from KSquareDB
      console.log("   🔍 Fetching course metadata...");
      const courses = await kSquareDB
        .collection("internships")
        .find({ type: "course" })
        .project({ _id: 1, title: 1 })
        .toArray();

      const courseNameMap = {};
      courses.forEach(c => {
        courseNameMap[c._id.toString()] = c.title;
      });
      console.log(`   ✅ Found ${courses.length} course definitions`);

      // 2. Initial stats from payments (Direct Enrollments)
      const paymentStats = await paymentCollection
        .aggregate([
            {
            $group: {
              _id: "$courseId",
              courseName: { $first: "$couseName" },
              enrollmentCount: { $sum: 1 },
            },
            },
        ])
        .toArray();

      // Map to store combined stats: courseId -> { courseName, enrollmentCount }
      const courseMap = {};

      // Populate with payment data
      paymentStats.forEach(course => {
        if (course._id) {
            // Use name from payment, or fallback to metadata map, or generic fallback
            const name = course.courseName || courseNameMap[course._id] || "Unknown Course";
            
            courseMap[course._id] = {
                courseName: name,
                enrollmentCount: course.enrollmentCount,
                source: "payment"
            };
        }
      });

      console.log(`   Direct Enrollments (Payment): ${paymentStats.reduce((acc, c) => acc + c.enrollmentCount, 0)}`);

      // 3. Fetch from College Assigned Courses
      const colleges = await globalDB
        .collection("organizations")
        .find({ type: "college" })
        .toArray();

      console.log(`   Fetching assigned courses from ${colleges.length} colleges...`);

      for (const college of colleges) {
        try {
            const orgDB = getOrgDB(college.orgId);
            
            // Get total student count
            const totalStudents = await orgDB.collection("student").countDocuments();

            // Get department student counts
            const departments = await orgDB.collection("department").find({}).project({_id: 1, students: 1}).toArray();
            const deptStudentCounts = {};
            departments.forEach(dept => {
                deptStudentCounts[dept._id.toString()] = dept.students ? dept.students.length : 0;
            });

            const assignedCourses = await orgDB.collection("assignedCourses").find({}).toArray();

            assignedCourses.forEach(assignment => {
                const courseId = assignment.refID;
                
                if (courseId) {
                    let count = 0;
                    const hasSpecificStudents = assignment.studentIds && assignment.studentIds.length > 0;
                    const hasSpecificDepts = assignment.departmentIds && assignment.departmentIds.length > 0;

                    if (hasSpecificStudents || hasSpecificDepts) {
                        if (hasSpecificStudents) {
                            count += assignment.studentIds.length;
                        }
                        if (hasSpecificDepts) {
                            assignment.departmentIds.forEach(deptId => {
                                count += (deptStudentCounts[deptId.toString()] || 0);
                            });
                        }
                    } else {
                        // If no specific students or departments, it means ALL students
                        count = totalStudents;
                    }

                    if (count > 0) {
                        if (courseMap[courseId]) {
                            courseMap[courseId].enrollmentCount += count;
                        } else {
                            // Look up name from metadata map
                            const name = courseNameMap[courseId] || `Course ${courseId.substring(0, 8)}...`;
                            
                            courseMap[courseId] = {
                                courseName: name,
                                enrollmentCount: count,
                                source: "college_assignment"
                            };
                        }
                    }
                }
            });
        } catch (err) {
            console.warn(`   ⚠️ Error fetching assigned courses for ${college.orgName}: ${err.message}`);
        }
      }

      // 4. Convert map to array and Sort
      const allCourses = Object.entries(courseMap).map(([id, data]) => ({
          _id: id,
          ...data
      }));

      // Sort by enrollment count
      allCourses.sort((a, b) => b.enrollmentCount - a.enrollmentCount);

      const totalEnrollments = allCourses.reduce((acc, c) => acc + c.enrollmentCount, 0);

      // 5. Separate Most and Least Popular
      const mostPopular = allCourses.slice(0, 5);
      
      // Least Popular: Just sort ascending and take top 5 (allow overlap)
      const leastPopular = [...allCourses].sort((a, b) => a.enrollmentCount - b.enrollmentCount).slice(0, 5);

      console.log(`   Total Combined Enrollments: ${totalEnrollments}`);
      console.log(`   Unique Courses: ${allCourses.length}`);

      return {
        totalEnrollments,
        mostPopular,
        leastPopular,
        courseStats: allCourses,
      };
    } catch (error) {
      console.error("❌ Error fetching course analytics:", error);
      throw new Error(`Error fetching course analytics: ${error.message}`);
    }
  }

  // ==================== GET JOB ACTIVITY ====================
  async getJobActivity() {
    try {
      console.log("\n📊 ========== FETCHING JOB ACTIVITY ==========");
      const kSquareDB = getKSquareDB();
      const studentsCollection = kSquareDB.collection("student");

      const stats = await studentsCollection
        .aggregate([
          {
            $project: {
              applicationsCount: {
                $cond: {
                  if: { $isArray: "$appliedJobs" },
                  then: { $size: "$appliedJobs" },
                  else: 0,
                },
              },
              isPlaced: {
                $cond: {
                    if: { $isArray: "$appliedJobs" },
                    then: {
                        $gt: [
                            {
                                $size: {
                                    $filter: {
                                        input: "$appliedJobs",
                                        as: "job",
                                        cond: { $eq: ["$$job.status", "approved"] }
                                    }
                                }
                            },
                            0
                        ]
                    },
                    else: false
                }
              },
            },
          },
          {
            $group: {
              _id: null,
              totalApplications: { $sum: "$applicationsCount" },
              totalStudents: { $sum: 1 },
              totalPlaced: { $sum: { $cond: ["$isPlaced", 1, 0] } },
            },
          },
        ])
        .toArray();

      const result = stats[0] || { totalApplications: 0, totalStudents: 0, totalPlaced: 0 };
      const avgApplications = result.totalStudents > 0 
        ? (result.totalApplications / result.totalStudents).toFixed(2) 
        : 0;

      console.log(`   Total Applications: ${result.totalApplications}`);
      console.log(`   Avg App/Student: ${avgApplications}`);

      return {
        applications: result.totalApplications,
        placements: result.totalPlaced,
        averageApplicationsPerStudent: avgApplications,
      };
    } catch (error) {
      console.error("❌ Error fetching job activity:", error);
      throw new Error(`Error fetching job activity: ${error.message}`);
    }
  }

  // ==================== GET PLACEMENT ANALYTICS ====================
  async getPlacementAnalytics() {
     try {
      console.log("\n📊 ========== FETCHING PLACEMENT ANALYTICS ==========");
      const kSquareDB = getKSquareDB();
      const studentsCollection = kSquareDB.collection("student");

       const stats = await studentsCollection
        .aggregate([
          {
            $project: {
              isPlaced: {
                $cond: {
                    if: { $isArray: "$appliedJobs" },
                    then: {
                        $gt: [
                            {
                                $size: {
                                    $filter: {
                                        input: "$appliedJobs",
                                        as: "job",
                                        cond: { $eq: ["$$job.status", "approved"] }
                                    }
                                }
                            },
                            0
                        ]
                    },
                    else: false
                }
              },
            },
          },
          {
            $group: {
              _id: null,
              totalStudents: { $sum: 1 },
              studentsPlaced: { $sum: { $cond: ["$isPlaced", 1, 0] } },
            },
          },
        ])
        .toArray();

      const result = stats[0] || { totalStudents: 0, studentsPlaced: 0 };
      const placementRate = result.totalStudents > 0
        ? ((result.studentsPlaced / result.totalStudents) * 100).toFixed(2) + "%"
        : "0%";

      console.log(`   Students Placed: ${result.studentsPlaced}`);
      console.log(`   Placement Rate: ${placementRate}`);

      return {
        studentsPlaced: result.studentsPlaced,
        placementRate,
        totalStudents: result.totalStudents
      };
    } catch (error) {
       console.error("❌ Error fetching placement analytics:", error);
       throw new Error(`Error fetching placement analytics: ${error.message}`);
    }
  }

  // ==================== GET REVENUE ANALYTICS ====================
  async getRevenueAnalytics() {
    try {
      console.log("\n📊 ========== FETCHING REVENUE ANALYTICS ==========");
      const globalDB = getGlobalDB();
      const paymentCollection = globalDB.collection("payment");

      const stats = await paymentCollection
        .aggregate([
          {
            $group: {
              _id: null,
              totalRevenue: { $sum: "$amountCharged" },
              revenueByCourse: {
                $push: {
                  courseId: "$courseId",
                  amount: "$amountCharged"
                }
              }
            }
          }
        ])
        .toArray();

      const result = stats[0] || { totalRevenue: 0 };
      
      const revenueByCourse = await paymentCollection.aggregate([
         {
            $group: {
                _id: "$courseId",
                courseName: { $first: "$couseName" },
                revenue: { $sum: "$amountCharged" }
            }
         },
         { $sort: { revenue: -1 } }
      ]).toArray();

      console.log(`   Total Revenue: ${result.totalRevenue}`);

      return {
        totalRevenue: result.totalRevenue,
        revenueByCourse,
      };
    } catch (error) {
      console.error("❌ Error fetching revenue analytics:", error);
      throw new Error(`Error fetching revenue analytics: ${error.message}`);
    }
  }
}

module.exports = new DashboardService();
