const cron = require('node-cron');
const { getSharedDB, getTenantDB } = require('../../../shared/db/connection');
const { notifyResultPublished } = require('../../../shared/utils/notificationService');

// Run every 5 minutes
cron.schedule('*/5 * * * *', async () => {
    try {
        
        const sharedDB = getSharedDB();
        const orgs = await sharedDB.collection('organizations').find({}).toArray();
        
        for (const org of orgs) {
            if (!org._id) continue;
            
            try {
                const orgIdStr = org.orgId || org._id.toString();
                const tenantDB = await getTenantDB(orgIdStr);
                const testCollection = tenantDB.collection('test');
                const progressCollection = tenantDB.collection('progress');

                // 1. Process "After Test Expiry" tests
                const expiredTests = await testCollection.find({
                    'resultsConfig.permanent.releaseMode': 'After Test Expiry',
                    endDate: { $lt: new Date().toISOString() }
                }).toArray();

                for (const test of expiredTests) {
                    const unnotifiedProgresses = await progressCollection.find({
                        testId: test._id.toString(),
                        resultNotified: { $ne: true },
                        $or: [ { notificationRetries: { $exists: false } }, { notificationRetries: { $lt: 3 } } ]
                    }).toArray();

                    const validProgresses = unnotifiedProgresses.filter(p => p && p.studentId);
                    if (validProgresses.length > 0) {
                        const studentIds = validProgresses.map(p => p.studentId.toString());
                        const result = await notifyResultPublished(orgIdStr, studentIds, test);
                        
                        if (result.success !== false) {
                            await progressCollection.updateMany(
                                { _id: { $in: validProgresses.map(p => p._id) } },
                                { $set: { resultNotified: true } }
                            );
                        } else {
                            await progressCollection.updateMany(
                                { _id: { $in: validProgresses.map(p => p._id) } },
                                { $inc: { notificationRetries: 1 } }
                            );
                        }
                    }
                }

                // 2. Process "Scheduled" tests
                const scheduledTests = await testCollection.find({
                    'resultsConfig.permanent.releaseMode': 'Scheduled',
                    'resultsConfig.permanent.releaseDate': { $lt: new Date().toISOString() }
                }).toArray();

                for (const test of scheduledTests) {
                    const unnotifiedProgresses = await progressCollection.find({
                        testId: test._id.toString(),
                        resultNotified: { $ne: true },
                        $or: [ { notificationRetries: { $exists: false } }, { notificationRetries: { $lt: 3 } } ]
                    }).toArray();

                    const validProgresses = unnotifiedProgresses.filter(p => p && p.studentId);
                    if (validProgresses.length > 0) {
                        const studentIds = validProgresses.map(p => p.studentId.toString());
                        const result = await notifyResultPublished(orgIdStr, studentIds, test);
                        
                        if (result.success !== false) {
                            await progressCollection.updateMany(
                                { _id: { $in: validProgresses.map(p => p._id) } },
                                { $set: { resultNotified: true } }
                            );
                        } else {
                            await progressCollection.updateMany(
                                { _id: { $in: validProgresses.map(p => p._id) } },
                                { $inc: { notificationRetries: 1 } }
                            );
                        }
                    }
                }

                // 3. Process "Manual Publish" bulk dispatch and failures
                const manualTests = await testCollection.find({
                    'resultsConfig.permanent.releaseMode': 'Manual'
                }).toArray();

                for (const test of manualTests) {
                    const allowedStudents = test.resultsConfig?.permanent?.manualPublishStudents || [];
                    if (allowedStudents.length === 0) continue;

                    const unnotifiedProgresses = await progressCollection.find({
                        testId: test._id.toString(),
                        studentId: { $in: allowedStudents },
                        resultNotified: { $ne: true },
                        $or: [ { notificationRetries: { $exists: false } }, { notificationRetries: { $lt: 3 } } ]
                    }).toArray();

                    const validProgresses = unnotifiedProgresses.filter(p => p && p.studentId);
                    if (validProgresses.length > 0) {
                        const studentIds = validProgresses.map(p => p.studentId.toString());
                        const result = await notifyResultPublished(orgIdStr, studentIds, test);
                        
                        if (result.success !== false) {
                            await progressCollection.updateMany(
                                { _id: { $in: validProgresses.map(p => p._id) } },
                                { $set: { resultNotified: true } }
                            );
                        } else {
                            await progressCollection.updateMany(
                                { _id: { $in: validProgresses.map(p => p._id) } },
                                { $inc: { notificationRetries: 1 } }
                            );
                        }
                    }
                }

                // 4. Process "Immediately" tests
                const immediateTests = await testCollection.find({
                    'resultsConfig.permanent.releaseMode': 'Immediately'
                }).toArray();

                for (const test of immediateTests) {
                    const unnotifiedProgresses = await progressCollection.find({
                        testId: test._id.toString(),
                        resultNotified: { $ne: true },
                        $or: [ { notificationRetries: { $exists: false } }, { notificationRetries: { $lt: 3 } } ]
                    }).toArray();

                    const validProgresses = unnotifiedProgresses.filter(p => p && p.studentId);
                    if (validProgresses.length > 0) {
                        // For immediate, everyone who submitted gets notified
                        const studentIds = validProgresses.map(p => p.studentId.toString());
                        const result = await notifyResultPublished(orgIdStr, studentIds, test);
                        
                        if (result.success !== false) {
                            await progressCollection.updateMany(
                                { _id: { $in: validProgresses.map(p => p._id) } },
                                { $set: { resultNotified: true } }
                            );
                        } else {
                            await progressCollection.updateMany(
                                { _id: { $in: validProgresses.map(p => p._id) } },
                                { $inc: { notificationRetries: 1 } }
                            );
                        }
                    }
                }

                // 5. Process "After Final Attempt" tests
                const finalAttemptTests = await testCollection.find({
                    'resultsConfig.permanent.releaseMode': 'After Final Attempt'
                }).toArray();

                for (const test of finalAttemptTests) {
                    const unnotifiedProgresses = await progressCollection.find({
                        testId: test._id.toString(),
                        resultNotified: { $ne: true },
                        $or: [ { notificationRetries: { $exists: false } }, { notificationRetries: { $lt: 3 } } ]
                    }).toArray();

                    if (unnotifiedProgresses.length > 0) {
                        const maxAttempts = Number(test.access?.attemptsPerRespondent) || 1;
                        
                        // Group by student to check total attempts
                        const studentIdsToNotify = [];
                        const progressesToMark = [];
                        
                        // We need to count total attempts for each unnotified student
                        const uniqueStudentIds = [...new Set(unnotifiedProgresses.map(p => p.studentId.toString()))];
                        
                        for (const studentId of uniqueStudentIds) {
                            const totalAttempts = await progressCollection.countDocuments({
                                studentId: studentId,
                                testId: test._id.toString(),
                                attemptGeneration: test.attemptGeneration || 0
                            });
                            
                            if (maxAttempts === -1 || totalAttempts >= maxAttempts) {
                                studentIdsToNotify.push(studentId);
                                const studentProgresses = unnotifiedProgresses.filter(p => p.studentId.toString() === studentId);
                                progressesToMark.push(...studentProgresses.map(p => p._id));
                            }
                        }

                        if (studentIdsToNotify.length > 0) {
                            const result = await notifyResultPublished(orgIdStr, studentIdsToNotify, test);
                            
                            if (result.success) {
                                await progressCollection.updateMany(
                                    { _id: { $in: progressesToMark } },
                                    { $set: { resultNotified: true } }
                                );
                            } else {
                                await progressCollection.updateMany(
                                    { _id: { $in: progressesToMark } },
                                    { $inc: { notificationRetries: 1 } }
                                );
                            }
                        }
                    }
                }

            } catch (err) {
                console.error(`[CRON] Error processing tenant DB for org ${org._id}:`, err.message);
            }
        }
    } catch (error) {
        console.error('[CRON] Fatal error in test result notification cron:', error);
    }
});
