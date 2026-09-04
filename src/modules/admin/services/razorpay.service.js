const { ObjectId } = require("mongodb");
const { paymentConfigCollection } = require("../../../shared/db/connection").getGlobalCollections();
const { archiveAndDeleteOne } = require("../../../shared/utils/archive.service");

// Controller: Save Razorpay Credentials
async function saveRazorpayCredentials(req, res) {
  try {
    const { keyId, keySecret } = req.body;

    if (!keyId || !keySecret) {
      return res.status(400).json({
        success: false,
        message: "Key ID and Key Secret are required",
      });
    }

    const collection = paymentConfigCollection;

    const credentialDoc = {
      keyId: keyId,
      keySecret: keySecret,
      updatedAt: new Date(),
    };

    const existing = await collection.findOne({ keyId: keyId });

    if (existing) {
      await collection.updateOne({ keyId: keyId }, { $set: credentialDoc });

      return res.status(200).json({
        success: true,
        message: "Razorpay credentials updated successfully",
        data: {
          credentialId: existing._id.toString(),
          keyId: keyId,
        },
      });
    } else {
      credentialDoc.createdAt = new Date();
      const result = await collection.insertOne(credentialDoc);

      return res.status(201).json({
        success: true,
        message: "Razorpay credentials saved successfully",
        data: {
          credentialId: result.insertedId.toString(),
          keyId: keyId,
        },
      });
    }
  } catch (error) {
    console.error("Error saving Razorpay credentials:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

// Controller: Get Razorpay Credentials
async function getRazorpayCredentials(req, res) {
  try {
    const collection = paymentConfigCollection;
    const credential = await collection.findOne({});

    if (!credential) {
      return res.status(200).json({
        success: false,
        message: "No Razorpay credentials found",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        keyId: credential.keyId,
        keySecret: credential.keySecret,
        createdAt: credential.createdAt,
        updatedAt: credential.updatedAt,
      },
    });
  } catch (error) {
    console.error("Error retrieving Razorpay credentials:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

// Controller: Delete Razorpay Credentials
async function deleteRazorpayCredentials(req, res) {
  try {
    const { keyId } = req.body;
    const collection = paymentConfigCollection;

    const archiveResult = await archiveAndDeleteOne(collection, { keyId: keyId }, {
      deletedBy: req.userID || null,
      reason: req.body.reason || null,
    });

    if (archiveResult.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "No credentials found to delete",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Razorpay credentials deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting Razorpay credentials:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

module.exports = {
  saveRazorpayCredentials,
  getRazorpayCredentials,
  deleteRazorpayCredentials,
};
