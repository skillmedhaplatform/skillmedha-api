require("dotenv").config({
  path: "../../.env",
});
const express = require("express");

const {
  Rekognition,
  DetectLabelsCommand,
  SearchFacesByImageCommand,
  IndexFacesCommand,
  CompareFacesCommand,
} = require("@aws-sdk/client-rekognition");
const mongoDB = require("mongodb");
const fs = require("fs");
const path = require("path");
const { rmSync } = require("fs");
const cors = require("cors");
const {
  getTotalPersons,
  checkExtraDevices,
} = require("./proctoringHelper.service");
// const { student } = require("../../mongoDB");
const { ObjectId } = require("mongodb");
const { mandatory: authenticate } = require("../../../shared/middleware/auth.middleware");
const { selectTenantDB } = require("../../../shared/middleware/selectTenantDB.middleware");
const { connectTodb, getTenantDB } = require("../../../shared/db/connection");
const axios = require("axios");
const azureBlobService = require("../../../shared/utils/azureBlobService");
const app = express.Router();
const port = 6886;








const rekog = new Rekognition({
  credentials: {
    accessKeyId: process.env.AWS_REKOG_KEY,
    secretAccessKey: process.env.AWS_REKOG_SECRET,
  },

  region: process.env.AWS_REGION,
});

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

const convertbase64ToBlob = (file, name) => {
  let base64ImageNew = file.split(";base64,").pop();
  fs.writeFileSync(
    "./uploads/" + name,
    base64ImageNew,
    { encoding: "base64" },
    function (err) {}
  );
  const fileContentNew = fs.readFileSync("./uploads/" + name);
  return fileContentNew;
};

const detectlabels = (file, fileName) => {
  const fileContent = convertbase64ToBlob(file, fileName);
  const params = {
    Image: {
      Bytes: fileContent,
    },
    Features: ["GENERAL_LABELS"],
    Settings: {
      GeneralLabels: {
        LabelCategoryInclusionFilters: [
          "Education",
          "Person Description",
          "Text and Documents",
          "Technology and Computing",
        ],
      },
    },
  };

  return rekog.send(new DetectLabelsCommand({ ...params }));
};

app.post("/detectlabels", async (req, res) => {
  const fileName = "detectFace.png";
  try {
    const data = await detectlabels(req.body.img, fileName);
    rmSync(`./uploads/${fileName}`);
    const numPersons = getTotalPersons(data.Labels);
    const checkDevices = checkExtraDevices(data.Labels);
    res.json({ data, numPersons, checkDevices });
  } catch (error) {
    console.error(error);
    // rmSync(`./uploads/${fileName}`);
    res.status(500).json({ success: false, message: error.message });
  }
});

const indexFacesFunc = (file, fileName) => {
  const fileContent = convertbase64ToBlob(file, fileName);
  const params = {
    CollectionId: "student_faces",
    DetectionAttributes: ["ALL"],
    Image: {
      Bytes: fileContent,
    },
    MaxFaces: 1,
    QualityFilter: "HIGH",
  };
  return rekog.send(new IndexFacesCommand(params));
};

app.post("/indexFaces", async (req, res) => {
  const fileName = "indexFace.png";
  const { student } = connectTodb(req.tenantDB);
  try {
    const indexData = await indexFacesFunc(req.body.img);
    rmSync(`./uploads/${fileName}`);
    const { studentId } = req.body;
    const updateStudent = await student.findOneAndUpdate(
      { _id: new ObjectId(studentId) },
      {
        $set: {
          faceIndexData: indexData,
        },
      }
    );
    res.send({ data: indexData });
  } catch (error) {
    // rmSync(`./uploads/${fileName}`);
    res.send({ err: error.message });
  }
});

const searchFacesByImageFun = (file, faceData, fileName) => {
  const fileContent = convertbase64ToBlob(file, fileName);
  const params = {
    CollectionId: "student_faces",
    FaceMatchThreshold: number,
    Image: {
      Bytes: fileContent,
    },
    MaxFaces: 1,
    QualityFilter: "HIGH",
  };
  return rekog.send(new SearchFacesByImageCommand(params));
};

const getTargetImageBytes = async (faceData, bucket_name) => {
  if (!faceData) {
    throw new Error("Student face data is not available. Please complete KYC verification first.");
  }

  // 1. If faceData is already a base64 string
  if (typeof faceData === "string" && faceData.startsWith("data:image")) {
    return Buffer.from(faceData.split(";base64,").pop(), "base64");
  }

  // 2. If faceData is a URL string or an object with file/url property
  const imageUrl = typeof faceData === "string" ? faceData : (faceData.file || faceData.url);
  if (imageUrl && (imageUrl.startsWith("http://") || imageUrl.startsWith("https://"))) {
    try {
      const response = await axios.get(imageUrl, {
        responseType: "arraybuffer",
        timeout: 10000,
      });
      return Buffer.from(response.data);
    } catch (fetchErr) {
      console.warn("Failed to fetch KYC image via HTTP URL, trying Azure Blob:", fetchErr.message);
    }
  }

  // 3. If faceData has a key or blob name in Azure Blob Storage
  const blobKey = faceData.key || (imageUrl ? path.basename(imageUrl.split("?")[0]) : null);
  if (blobKey) {
    const container = bucket_name && bucket_name !== "synsper-test-series" ? bucket_name : "skillmedha-utils";
    try {
      return await azureBlobService.downloadBlob(container, blobKey);
    } catch (azureErr) {
      if (container !== "skillmedha-utils") {
        return await azureBlobService.downloadBlob("skillmedha-utils", blobKey);
      }
      throw azureErr;
    }
  }

  throw new Error("Could not retrieve stored KYC image for face comparison");
};

const compareFacesFun = async (newFace, faceData, bucket_name) => {
  const sourceBytes = typeof newFace === "string" && newFace.startsWith("data:image")
    ? Buffer.from(newFace.split(";base64,").pop(), "base64")
    : Buffer.from(newFace);

  const targetBytes = await getTargetImageBytes(faceData, bucket_name);

  const params = {
    QualityFilter: "HIGH",
    SimilarityThreshold: 80,
    SourceImage: {
      Bytes: sourceBytes,
    },
    TargetImage: {
      Bytes: targetBytes,
    },
  };
  return rekog.send(new CompareFacesCommand(params));
};

app.post("/compareFaces", async (req, res) => {
  try {
    const { studentId, bucket_name, img } = req.body;
    if (!studentId) {
      return res.status(400).json({ success: false, err: "studentId is required" });
    }
    if (!img) {
      return res.status(400).json({ success: false, err: "Camera image is required" });
    }

    let studentCol = req.tenantDB ? connectTodb(req.tenantDB)?.student : null;
    if (!studentCol && req.orgId) {
      const db = await getTenantDB(req.orgId);
      studentCol = connectTodb(db)?.student;
    }

    if (!studentCol) {
      return res.status(500).json({ success: false, err: "Database connection for tenant is unavailable" });
    }

    let studentData = null;
    if (ObjectId.isValid(studentId)) {
      studentData = await studentCol.findOne({ _id: new ObjectId(studentId) });
    }
    if (!studentData) {
      studentData = await studentCol.findOne({ _id: studentId });
    }
    if (!studentData) {
      studentData = await studentCol.findOne({ globalId: studentId });
    }

    if (!studentData) {
      return res.status(404).json({
        success: false,
        err: `Student record not found (ID: ${studentId})`,
      });
    }

    if (!studentData?.faceData) {
      return res.status(400).json({
        success: false,
        err: "No KYC face data found for this student. Please complete KYC first.",
      });
    }

    const compareFaces = await compareFacesFun(
      img,
      studentData.faceData,
      bucket_name
    );

    const faceMatches = compareFaces?.FaceMatches || [];
    const hasMatch = faceMatches.length > 0;
    const similarity = hasMatch ? faceMatches[0].Similarity : 0;
    const isMatched = hasMatch && similarity >= 85;

    res.json({
      success: isMatched,
      matched: isMatched,
      similarity,
      FaceMatches: faceMatches,
      UnmatchedFaces: compareFaces.UnmatchedFaces || [],
      data: compareFaces,
    });
  } catch (error) {
    console.error("compareFaces error:", error.message);
    res.status(500).json({ success: false, err: error.message, error: error.message });
  }
});

module.exports = app;
