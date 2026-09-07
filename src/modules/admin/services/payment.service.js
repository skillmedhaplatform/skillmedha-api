const express = require("express");
const Crypto = require("crypto");
const Razorpay = require("razorpay");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");

const mongoDB = require("mongodb");
const nodemailer = require("nodemailer");
const bcrypt = require("bcryptjs");

const {
  mainDBusers,
  studentsCollection,
  rzp_payemntDetails,
  payment,
  paymentConfigCollection,
} = require("../../../shared/db/connection").getGlobalCollections();
const { getTenantDB, connectTodb } = require("../../../shared/db/connection");
const { mandatory } = require("../../../shared/middleware/auth.middleware");
const { selectTenantDB } = require("../../../shared/middleware/selectTenantDB.middleware");
const sucessMail = require("../../../shared/utils/sucessMail");

const router = express.Router();

const instance = new Razorpay({
  key_id: process.env.RZP_ID,
  key_secret: process.env.RZP_SECRET,
});

const transporters = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.support_mail,
    pass: process.env.support_pass,
  },
});

router.post("/createOrder", async (req, res) => {
  const { amount, id, description, name, email, notes, phone, coupon } =
    req.body;

  const checkStudent = await mainDBusers.findOne({ email: email });

  if (
    (checkStudent && !checkStudent.course) ||
    (checkStudent && !checkStudent.course.find((e) => e == id)) ||
    (checkStudent &&
      !checkStudent.course.find((e) => e == id) &&
      checkStudent.courseEnrolledData &&
      !checkStudent.courseEnrolledData.find((m) => m.courseId == id)) ||
    checkStudent?.courseEnrolledData?.find((m) => m.courseId == id)?.active ==
    false
  ) {
    const order = await instance.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: uuidv4(),
      notes: {
        id,
        description,
        name,
        coupon,
      },
    });
    order.description = name + "|" + description + "|" + id;

    res.status(200).json(order); // ✅ FIXED
  } else if (!checkStudent) {
    const { phone } = req.body;
    const salt = await bcrypt.genSalt();

    const hash = await bcrypt.hash(phone, salt);
    mainDBusers
      .insertOne({
        email: email,
        firstName: name.split(" ")[0],
        lastName: name.split(" ")[1],
        phone: phone,
        password: hash,
        type: "student",
        active: true,
      })
      .then(async () => {
        await studentsCollection.insertOne({
          email: email,
          firstName: name.split(" ")[0],
          lastName: name.split(" ")[1],
          phone: phone,
          password: hash,
          type: "student",
          active: true,
        });
        const order = await instance.orders.create({
          amount: amount * 100,
          currency: "INR",
          receipt: uuidv4(),
          notes: {
            id,
            description,
            name,
            coupon,
          },
        });
        order.description = name + "|" + description + "|" + id;

        var mailOptions = {
          from: process.env.support_mail,
          to: email,
          subject: "Account Created Successfully",
          html: `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Account Created Successfully</title>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        background-color: #f0f0f0;
                        text-align: center;
                    }
                    .container {
                        max-width: 400px;
                        margin: 0 auto;
                        padding: 20px;
                        background-color: #fff;
                        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                        border-radius: 5px;
                        margin-top: 50px;
                    }
                    h1 {
                        color: #333;
                    }
                    p {
                        color: #666;
                    }
                    .btn {
                        display: inline-block;
                        padding: 10px 20px;
                        background-color: #007bff;
                        color: #fff;
                        text-decoration: none;
                        border-radius: 5px;
                        margin-top: 20px;
                    }
                    .btn:hover {
                        background-color: #0056b3;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Account Created Successfully</h1>
                    <p>Your account has been successfully created. To Login use your phone number as password. You can change your password in the dashboard.</p>
                    <a href="${process.env.STUDENT_PORTAL_URL}" class="btn">Go to Dashboard</a>
                </div>
            </body>
            </html>
          `,
        };

        transporters.sendMail(mailOptions, function (error, info) {
          if (error) {
            console.log({
              status: true,
              respMesg: error,
            });
          } else {
            console.log({
              status: true,
              respMesg: "Email Sent Successfully",
            });
          }
        });

        res.status(200).json(order); // ✅ FIXED
      })
      .catch((error) => {
        console.error(error);
        res.status(500).json({ error: "Failed to create student account" }); // ✅ ADDED ERROR HANDLING
      });
  } else if (checkStudent.course.includes(id)) {
    res.status(400).json({ error: "You already enrolled this course" }); // ✅ FIXED
  }
});

router.post("/payment_links", async (req, res) => {
  try {
    const {
      amount,
      id,
      description,
      name,
      email,
      courseName,
      notes,
      phone,
      coupon,
      Installment,
    } = req.body;

    const Bodie = {
      amount: amount * 100,
      currency: "INR",
      description: "Payment Links",
      customer: {
        name: name,
        email: email,
        contact: phone,
      },
      notify: {
        sms: true,
        email: true,
      },
      reminder_enable: true,
      notes: {
        id,
        description,
        courseName: courseName,
        name: name,
        createdAt: req.body.createdAt,
        Installment: Installment ? Installment : false,
        // policy_name: "Jeevan Bima"
      },
    };

    const checkStudent = await studentsCollection.findOne({ email: email });
    if (
      (checkStudent && !checkStudent.course) ||
      (checkStudent && !checkStudent.course.find((e) => e == id)) ||
      (checkStudent &&
        !checkStudent.course.find((e) => e == id) &&
        checkStudent.courseEnrolledData &&
        !checkStudent.courseEnrolledData.find((m) => m.courseId == id))
    ) {
      await axios.post(
        "https://api.razorpay.com/v1/payment_links",
        { ...Bodie },
        {
          auth: {
            username: process.env.RZP_ID,
            password: process.env.RZP_SECRET,
          },
        }
      );
      res.send("paid");
    } else if (!checkStudent) {
      const salt = await bcrypt.genSalt();

      const inst = Installment ? Installment : false;
      const hash = await bcrypt.hash(phone?.split("+91")[1], salt);
      await studentsCollection
        .insertOne({
          email: email,
          firstName: name.split(" ")[0],
          lastName: name.split(" ")[1],
          phone: phone,
          password: hash,
          Installment: inst,
          active: true,
          type: "student",
        })
        .then(async () => {
          await axios.post(
            "https://api.razorpay.com/v1/payment_links",
            { ...Bodie },
            {
              auth: {
                username: process.env.RZP_ID,
                password: process.env.RZP_SECRET,
              },
            }
          );
          var mailOptions = {
            from: process.env.support_mail, // sender address
            to: email, // list of receivers,
            subject: "Account Created Successfully",
            html: `
                            
              <!DOCTYPE html>
              <html lang="en">
              <head>
                  <meta charset="UTF-8">
                  <meta name="viewport" content="width=device-width, initial-scale=1.0">
                  <title>Account Created Successfully</title>
                  <style>
                      body {
                          font-family: Arial, sans-serif;
                          background-color: #f0f0f0;
                          text-align: center;
                      }
                      .container {
                          max-width: 400px;
                          margin: 0 auto;
                          padding: 20px;
                          background-color: #fff;
                          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                          border-radius: 5px;
                          margin-top: 50px;
                      }
                      h1 {
                          color: #333;
                      }
                      p {
                          color: #666;
                      }
                      .btn {
                          display: inline-block;
                          padding: 10px 20px;
                          background-color: #007bff;
                          color: #fff;
                          text-decoration: none;
                          border-radius: 5px;
                          margin-top: 20px;
                      }
                      .btn:hover {
                          background-color: #0056b3;
                      }
                  </style>
              </head>
              <body>
                  <div class="container">
                      <h1>Account Created Successfully</h1><br/>
                      <h1>Hello Mr/Mrs ${name}</h1>
                      <p>Your account has been successfully created.To Login use your phone number as password. You can change your password in the dashboard.</p>
                      <a href="${process.env.STUDENT_PORTAL_URL}" class="btn">Go to Dashboard</a>
                  </div>
              </body>
              </html>
          `,
          };

          transporters.sendMail(mailOptions, function (error, info) {
            if (error) {
              console.log({
                status: true,
                respMesg: error,
              });
            } else {
              console.log({
                status: true,
                respMesg: "Email Sent Successfully",
              });
            }
          });
        });
    } else {
      res.send("Student already enrolled this course");
    }
    //  console.log(data)
    res.send("success");
  } catch (error) {
    console.log(error.message);
  }
});

router.post("/webhook", async (req, res) => {
  try {
    const email = req.body.payload.payment_link.entity.customer.email;

    const currStudentEmail = await studentsCollection.findOne({ email: email });

    if (req.body.payload.payment_link.entity.status == "paid") {
      const variables = {
        amountCharged: req.body.payload.payment_link.entity.amount_paid / 100,
        orderId: req.body.payload.payment_link.entity.order_id,
        modeOfPay: req.body.payload.payment.entity.method,
        status: req.body.payload.payment_link.entity.status,
        email: email,
        courseId: req.body.payload.payment_link.entity.notes.id,
        couseName: req.body.payload.payment_link.entity.notes.courseName,
        createdAt: req.body.payload.payment_link.entity.notes.createdAt,
        userId: currStudentEmail._id,
      };

      const paymentdone = await payment.insertOne({ ...variables });

      if (paymentdone) {
        await studentsCollection.updateOne(
          { _id: currStudentEmail._id },
          {
            $push: {
              payment: paymentdone.insertedId.toString(),
              course: req.body.payload.payment_link.entity.notes.id,

              courseEnrolledData: {
                courseId: req.body.payload.payment_link.entity.notes.id,
                courseDate:
                  req.body.payload.payment_link.entity.notes.createdAt,
              },
            },
          }
        );

        await studentsCollection.updateOne(
          { _id: currStudentEmail._id },
          {
            $set: {
              amountCharged:
                req.body.payload.payment_link.entity.amount_paid / 100,
            },
          }
        );
        res.status(200).send({ data: "Success" });
      } else {
        res.status(200).send({ data: "Success" });
      }
    } else {
      res.status(200).send({ data: "Success" });
    }
  } catch (error) {
    console.log(error);
    res.status(200).send({ data: "Success" });
  }
});

router.get("/getKey", async (req, res) => {
  const data = await paymentConfigCollection.find({}).toArray();
  if (data.length) {
    res.send(data[0]?.keyId);
    return;
  }
  res.send(process.env.RZP_ID);
});
router.get("/getSecret", async (req, res) => {
  const data = await paymentConfigCollection.find({}).toArray();
  if (data.length) {
    res.send(data[0]?.keySecret);
    return;
  }
  res.send(process.env.RZP_SECRET);
});
router.post("/verify", async (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } =
    req.body;
  const body = razorpay_order_id + "|" + razorpay_payment_id;
  const generated_signature = Crypto.createHmac(
    "sha256",
    process.env.RZP_SECRET
  )
    .update(body)
    .digest("hex");

  if (generated_signature === razorpay_signature) {
    const payment_details = await rzp_payemntDetails.insertOne({
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      createdAt: new Date().toLocaleString(),
    });

    const frontendUrl = process.env.FRONTEND_APP_URL || "http://localhost:3000";
    res.redirect(
      frontendUrl + "/thankyou.html?paymentId=" + razorpay_payment_id
    );
  } else {
    res.status(400).json({
      sucess: true,
      data: req.body,
    });
  }
});
router.post("/getPayment", async (req, res) => {
  const { paymentId, installments } = req.body;
  const { data } = await axios.get(
    "https://api.razorpay.com/v1/payments/" + paymentId,
    {
      auth: {
        username: process.env.RZP_ID,
        password: process.env.RZP_SECRET,
      },
    }
  );

  try {
    const courseID = data.notes.id || data.notes.courseId;

    if (data.status == "captured") {
      // Check if payment already processed
      const existingPayment = await payment.findOne({ orderId: data.order_id });

      if (existingPayment) {
        return res.status(200).json({
          message: "Payment already processed",
          data,
        });
      }

      const variables = {
        amountCharged: data.amount / 100,
        currency: data.currency,
        orderId: data.order_id,
        modeOfPay: data.method,
        status: data.status,
        email: data.email,
        courseId: courseID,
        courseName: data.notes.courseName,
        createdAt: new Date(),
        paymentId: paymentId,
      };

      const paymentdone = await payment.insertOne({ ...variables });

      if (paymentdone) {
        let currStudentEmail;

        if (data.email) {
          currStudentEmail = await mainDBusers.findOne({ email: data.email });
        }

        if (!currStudentEmail && data.notes.userId) {
          const id = new mongoDB.ObjectId(data.notes.userId);
          currStudentEmail = await mainDBusers.findOne({ _id: id });
        }

        if (!currStudentEmail) {
          return res.status(404).json({ error: "Student not found" });
        }

        // ✅ FIXED: Check if course already enrolled
        const alreadyEnrolled =
          currStudentEmail.subscriptions?.includes(courseID) ||
          currStudentEmail.enrolledData?.some((e) => e.refId === courseID);

        if (alreadyEnrolled) {
          return res.status(400).json({
            error: "You already enrolled in this course",
            data,
          });
        }

        // ✅ Add course enrollment (only once)
        await mainDBusers.updateOne(
          { _id: currStudentEmail._id },
          {
            $push: {
              payment: paymentdone.insertedId.toString(),
              subscriptions: courseID,
              installments: {
                courseId: courseID,
                firstInstallment: true,
                secondInstallment: false,
                amountCharged: data.amount / 100,
              },
              enrolledData: {
                refId: courseID,
                createdAt: new Date(),
                active: true,
                type: data.notes.type,
              },
            },
            $set: {
              amountCharged: data.amount / 100,
              coupon: data.notes.coupon || "",
            },
          }
        );

        // Send success email
        transporters.sendMail(sucessMail(data), function (error, info) {
          if (error) {
            console.log({
              status: false,
              respMesg: error,
            });
          } else {
            console.log({
              status: true,
              respMesg: "Email Sent Successfully",
            });
          }
        });

        return res.status(200).json({
          success: true,
          message: "Payment processed successfully",
          data,
        });
      }
    } else {
      // Payment failed
      var mailOptions = failMailTemplate(data);

      transporters.sendMail(mailOptions, function (error, info) {
        if (error) {
          console.log({
            status: false,
            respMesg: error,
          });
        } else {
          console.log({
            status: true,
            respMesg: "Failed payment email sent",
          });
        }
      });

      return res.status(400).json({
        success: false,
        message: "Payment failed",
        data,
      });
    }
  } catch (error) {
    console.error("Payment processing error:", error);
    return res.status(500).json({
      error: "Payment processing failed",
      details: error.message,
    });
  }
});

router.post("/getPaymentID", async (req, res) => {
  try {
    const { PaymentId } = req.body;

    const id = new mongoDB.ObjectId(PaymentId);

    const data = await payment.findOne({ _id: id });

    res.send(data);
  } catch (error) {
    res.send(error);
  }
});

// ─── Cart checkout (multi-course, single Razorpay order) ──────────────────────

async function resolveCartCourseType(courseId, tenantDB) {
  const { internships: tenantCourses } = connectTodb(tenantDB);
  let course = await tenantCourses.findOne(
    { _id: new mongoDB.ObjectId(courseId) },
    { projection: { type: 1 } }
  );
  if (course) return course.type || "course";

  const kSquareDB = await getTenantDB("KSquare");
  const { internships: kCourses } = connectTodb(kSquareDB);
  course = await kCourses.findOne(
    { _id: new mongoDB.ObjectId(courseId) },
    { projection: { type: 1 } }
  );
  return course?.type || "course";
}

router.post("/cart/createOrder", mandatory, selectTenantDB, async (req, res) => {
  try {
    const { cart } = connectTodb(req.tenantDB);
    const cartDoc = await cart.findOne({ student: req.userID });

    if (!cartDoc?.items?.length) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const student = await mainDBusers.findOne({
      _id: new mongoDB.ObjectId(req.userID),
    });
    if (!student) {
      return res.status(404).json({ error: "Student not found" });
    }

    const alreadyEnrolledIds = new Set(
      (student.enrolledData || []).map((e) => e.refId)
    );
    const pendingItems = cartDoc.items.filter(
      (item) => !alreadyEnrolledIds.has(item.courseId)
    );

    if (!pendingItems.length) {
      return res
        .status(400)
        .json({ error: "All courses in cart are already purchased" });
    }

    const itemsWithType = await Promise.all(
      pendingItems.map(async (item) => ({
        courseId: item.courseId,
        price: item.price,
        discountedPrice: item.discountedPrice,
        type: await resolveCartCourseType(item.courseId, req.tenantDB),
      }))
    );

    const totalAmount = itemsWithType.reduce(
      (sum, i) => sum + (i.discountedPrice ?? i.price ?? 0),
      0
    );
    const courseIds = itemsWithType.map((i) => i.courseId);

    if (totalAmount === 0) {
      await mainDBusers.updateOne(
        { _id: student._id },
        {
          $push: {
            subscriptions: { $each: courseIds },
            installments: {
              $each: itemsWithType.map((i) => ({
                courseId: i.courseId,
                firstInstallment: true,
                secondInstallment: false,
                amountCharged: 0,
              })),
            },
            enrolledData: {
              $each: itemsWithType.map((i) => ({
                refId: i.courseId,
                createdAt: new Date(),
                active: true,
                type: i.type,
              })),
            },
          },
        }
      );

      await cart.updateOne({ student: req.userID }, { $set: { items: [] } });

      return res.status(200).json({ orderId: null, enrolled: true, courseIds });
    }

    // `instance` (Razorpay SDK client) is created once at module load from
    // process.env.RZP_ID/RZP_SECRET and never re-reads paymentConfigCollection —
    // so the order below is always created under the env key. The checkout
    // widget key handed to the frontend MUST be that exact same key, or
    // Razorpay rejects the widget with "Authentication failed" even though
    // the order itself is valid. (Previously this read a DB-stored keyId
    // that could silently drift from the env value — it had, by one
    // truncated character, which is exactly what broke this.)
    const keyId = process.env.RZP_ID;

    const order = await instance.orders.create({
      amount: totalAmount * 100,
      currency: "INR",
      receipt: uuidv4(),
      notes: {
        items: JSON.stringify(
          itemsWithType.map((i) => ({ courseId: i.courseId, type: i.type }))
        ),
        userID: req.userID,
        orgId: req.orgId,
      },
    });

    return res.status(200).json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId,
    });
  } catch (error) {
    console.error("Cart createOrder error:", error);
    res.status(500).json({ error: "Failed to create cart order" });
  }
});

router.post("/cart/verify", mandatory, selectTenantDB, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res
        .status(400)
        .json({ error: "Missing payment verification fields" });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const generated_signature = Crypto.createHmac("sha256", process.env.RZP_SECRET)
      .update(body)
      .digest("hex");

    if (generated_signature !== razorpay_signature) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid payment signature" });
    }

    const existingPayment = await payment.findOne({ orderId: razorpay_order_id });
    if (existingPayment) {
      return res.status(200).json({
        success: true,
        message: "Payment already processed",
        enrolledCourses: existingPayment.courseIds || [],
      });
    }

    const order = await instance.orders.fetch(razorpay_order_id);
    let items = [];
    try {
      items = JSON.parse(order.notes?.items || "[]");
    } catch (e) {
      items = [];
    }

    if (!items.length) {
      return res.status(400).json({ error: "No courses found for this order" });
    }

    const student = await mainDBusers.findOne({
      _id: new mongoDB.ObjectId(order.notes.userID),
    });
    if (!student) {
      return res.status(404).json({ error: "Student not found" });
    }

    const alreadyEnrolledIds = new Set(
      (student.enrolledData || []).map((e) => e.refId)
    );
    const newItems = items.filter((i) => !alreadyEnrolledIds.has(i.courseId));
    const courseIds = items.map((i) => i.courseId);
    const amountCharged = order.amount / 100;

    const paymentdone = await payment.insertOne({
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      amountCharged,
      currency: order.currency,
      courseIds,
      email: student.email,
      createdAt: new Date(),
    });

    if (newItems.length) {
      await mainDBusers.updateOne(
        { _id: student._id },
        {
          $push: {
            payment: paymentdone.insertedId.toString(),
            subscriptions: { $each: newItems.map((i) => i.courseId) },
            installments: {
              $each: newItems.map((i) => ({
                courseId: i.courseId,
                firstInstallment: true,
                secondInstallment: false,
                amountCharged,
              })),
            },
            enrolledData: {
              $each: newItems.map((i) => ({
                refId: i.courseId,
                createdAt: new Date(),
                active: true,
                type: i.type,
              })),
            },
          },
          $set: { amountCharged },
        }
      );
    }

    const { cart } = connectTodb(req.tenantDB);
    await cart.updateOne({ student: req.userID }, { $set: { items: [] } });

    transporters.sendMail(
      sucessMail({
        email: student.email,
        notes: { name: `${student.firstName || ""} ${student.lastName || ""}`.trim() },
      }),
      (error, info) => {
        if (error) {
          console.log({ status: false, respMesg: error });
        } else {
          console.log({ status: true, respMesg: "Email Sent Successfully" });
        }
      }
    );

    return res.status(200).json({
      success: true,
      message: "Payment processed successfully",
      enrolledCourses: courseIds,
    });
  } catch (error) {
    console.error("Cart verify error:", error);
    res
      .status(500)
      .json({ error: "Payment verification failed", details: error.message });
  }
});

// ─── Buy Now (single course, bypasses the cart) ────────────────────────────
// Mirrors the cart checkout above (same auth, same enrollment/payment
// record shape, same zero-price auto-enroll path) but for exactly one
// course a student wants to pay for right now, independent of whatever
// else is sitting in their cart.

async function resolveCourseForCheckout(courseId, tenantDB) {
  const { internships: tenantCourses } = connectTodb(tenantDB);
  let course = await tenantCourses.findOne({ _id: new mongoDB.ObjectId(courseId) });
  if (course) return course;

  const kSquareDB = await getTenantDB("KSquare");
  const { internships: kCourses } = connectTodb(kSquareDB);
  return kCourses.findOne({ _id: new mongoDB.ObjectId(courseId) });
}

router.post("/buyNow/createOrder", mandatory, selectTenantDB, async (req, res) => {
  try {
    const { courseId } = req.body;
    if (!courseId) {
      return res.status(400).json({ error: "courseId is required" });
    }

    const student = await mainDBusers.findOne({
      _id: new mongoDB.ObjectId(req.userID),
    });
    if (!student) {
      return res.status(404).json({ error: "Student not found" });
    }

    const alreadyEnrolled = (student.enrolledData || []).some(
      (e) => e.refId === courseId
    );
    if (alreadyEnrolled) {
      return res.status(400).json({ error: "You already enrolled this course" });
    }

    const course = await resolveCourseForCheckout(courseId, req.tenantDB);
    if (!course) {
      return res.status(404).json({ error: "Course not found" });
    }

    const type = course.type || "course";
    // Never trust a client-supplied amount — resolve the real price
    // server-side from the course record itself.
    const price =
      course.pricing?.finalPrice ??
      course.discountedPrice ??
      course.pricing?.currentPrice ??
      course.pricing?.originalPrice ??
      course.price ??
      0;

    if (price === 0) {
      await mainDBusers.updateOne(
        { _id: student._id },
        {
          $push: {
            subscriptions: courseId,
            installments: {
              courseId,
              firstInstallment: true,
              secondInstallment: false,
              amountCharged: 0,
            },
            enrolledData: { refId: courseId, createdAt: new Date(), active: true, type },
          },
        }
      );

      return res.status(200).json({ orderId: null, enrolled: true, courseId });
    }

    // Same reasoning as /cart/createOrder above: the widget key must match
    // the env key `instance` actually used to create this order.
    const keyId = process.env.RZP_ID;

    const order = await instance.orders.create({
      amount: price * 100,
      currency: "INR",
      receipt: uuidv4(),
      notes: { courseId, type, userID: req.userID, orgId: req.orgId },
    });

    return res.status(200).json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId,
      courseName: course.title,
    });
  } catch (error) {
    console.error("Buy Now createOrder error:", error);
    res.status(500).json({ error: "Failed to create order" });
  }
});

router.post("/buyNow/verify", mandatory, selectTenantDB, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment verification fields" });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const generated_signature = Crypto.createHmac("sha256", process.env.RZP_SECRET)
      .update(body)
      .digest("hex");

    if (generated_signature !== razorpay_signature) {
      return res.status(400).json({ success: false, error: "Invalid payment signature" });
    }

    const existingPayment = await payment.findOne({ orderId: razorpay_order_id });
    if (existingPayment) {
      return res.status(200).json({
        success: true,
        message: "Payment already processed",
        enrolledCourses: existingPayment.courseIds || [],
      });
    }

    const order = await instance.orders.fetch(razorpay_order_id);
    const { courseId, type } = order.notes || {};
    if (!courseId) {
      return res.status(400).json({ error: "No course found for this order" });
    }

    const student = await mainDBusers.findOne({
      _id: new mongoDB.ObjectId(order.notes.userID),
    });
    if (!student) {
      return res.status(404).json({ error: "Student not found" });
    }

    const alreadyEnrolled = (student.enrolledData || []).some(
      (e) => e.refId === courseId
    );
    const amountCharged = order.amount / 100;

    const paymentdone = await payment.insertOne({
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      amountCharged,
      currency: order.currency,
      courseIds: [courseId],
      email: student.email,
      createdAt: new Date(),
    });

    if (!alreadyEnrolled) {
      await mainDBusers.updateOne(
        { _id: student._id },
        {
          $push: {
            payment: paymentdone.insertedId.toString(),
            subscriptions: courseId,
            installments: {
              courseId,
              firstInstallment: true,
              secondInstallment: false,
              amountCharged,
            },
            enrolledData: { refId: courseId, createdAt: new Date(), active: true, type },
          },
          $set: { amountCharged },
        }
      );
    }

    transporters.sendMail(
      sucessMail({
        email: student.email,
        notes: { name: `${student.firstName || ""} ${student.lastName || ""}`.trim() },
      }),
      (error) => {
        if (error) {
          console.log({ status: false, respMesg: error });
        } else {
          console.log({ status: true, respMesg: "Email Sent Successfully" });
        }
      }
    );

    return res.status(200).json({
      success: true,
      message: "Payment processed successfully",
      enrolledCourses: [courseId],
    });
  } catch (error) {
    console.error("Buy Now verify error:", error);
    res
      .status(500)
      .json({ error: "Payment verification failed", details: error.message });
  }
});

module.exports = router;
