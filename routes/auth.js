// routes/auth.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { authorize } = require('../middleware/authMiddleware');

/* =============================
   Helpers
============================= */
function getAffiliation(email = '') {
  // ✅ everyone with @g.msuiit.edu.ph is considered MSU-IIT
  return /@g\.msuiit\.edu\.ph$/i.test(String(email).toLowerCase().trim())
    ? 'MSU-IIT'
    : 'external';
}


function signAuthToken(user) {
  const affiliation = getAffiliation(user.email);
  return jwt.sign(
    {
      id: user._id,
      email: user.email,
      role: user.role,
      affiliation,           // now aligns with the single rule above
      college: user.college || '',
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d', issuer: 'repo-api' }
  );
}

/* =============================
   📧 Email Transporter (Gmail)
============================= */
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: { rejectUnauthorized: false },
});

transporter.verify((error) => {
  if (error) console.error('❌ Email transporter error:', error);
  else console.log('✅ Email transporter ready');
});

/* =============================
   📧 One helper for all system emails
============================= */
function sendSystemEmail({ to, subject, text }) {
  return transporter.sendMail({
    from:
      process.env.EMAIL_FROM ||
      'Research Repo Mailer (no-reply) <no-reply@repo.msuiit.edu.ph>',
    to,
    subject,
    text,
    replyTo: process.env.REPLY_TO || 'no-reply@repo.msuiit.edu.ph',
    headers: {
      'Auto-Submitted': 'auto-generated',
      'Precedence': 'bulk',
      'X-Auto-Response-Suppress': 'All',
    },
    // many mailbox providers ignore this unless domain is verified
    envelope: {
      from: process.env.RETURN_PATH || 'bounce@repo.msuiit.edu.ph',
      to,
    },
  });
}

/* =============================
   👤 Register
============================= */
router.post('/register', async (req, res) => {
  try {
    let { firstName, lastName, email, role, college } = req.body;

    // Accept multiple possible PIN keys from client
    let rawPin =
      req.body.pin ?? req.body.password ?? req.body.pinCode ?? req.body.code ?? '';

    rawPin = String(rawPin).trim();
    email = String(email || '').toLowerCase().trim();
    firstName = String(firstName || '').trim();
    lastName = String(lastName || '').trim();

    if (!firstName || !lastName || !email || !rawPin) {
      return res.status(400).json({ error: 'All fields required' });
    }
    if (!/^\d{6}$/.test(rawPin)) {
      return res.status(400).json({ error: 'PIN must be 6 digits' });
    }

    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const pinHash = await bcrypt.hash(rawPin, 10);

    const user = new User({
      firstName,
      lastName,
      email,
      pinHash,
      role: role || 'student',
      college: college || '',
      verified: false,
    });

    await user.save();
    return res
      .status(201)
      .json({ message: 'Registered successfully, please verify your email on first login.' });
  } catch (err) {
    console.error('❌ Registration error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* =============================
   🔐 Login (PIN-based)
============================= */
router.post('/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    const rawPin = String(
      req.body.pin ?? req.body.password ?? req.body.pinCode ?? ''
    ).trim();

    if (!email || !rawPin) {
      return res.status(400).json({ error: 'Email and 6-digit PIN are required' });
    }
    if (!/^\d{6}$/.test(rawPin)) {
      return res.status(400).json({ error: 'PIN must be 6 digits' });
    }

    const user = await User.findOne({ email }).select(
      '+pinHash email role firstName lastName verified verificationCode college'
    );

    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.pinHash) {
      return res
        .status(409)
        .json({ error: 'Account has no PIN set. Please reset your PIN.' });
    }

    const isMatch = await bcrypt.compare(rawPin, user.pinHash);
    if (!isMatch) return res.status(401).json({ error: 'Invalid PIN' });

    // Not verified yet → send verification code
    if (!user.verified) {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      user.verificationCode = code;
      await user.save();

      try {
        await sendSystemEmail({
          to: user.email,
          subject: 'Verify your Research Repository account',
          text: `Your verification code is: ${code}\n\nThis is an automated message.`,
        });
      } catch (mailErr) {
        console.error('❌ Send verification email failed:', mailErr);
      }

      return res.json({ needsVerification: true, email: user.email });
    }

    const token = signAuthToken(user);
    return res.json({
      needsVerification: false,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        token,
      },
    });
  } catch (err) {
    console.error('❌ Login error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* =============================
   ✉️ Send PIN reset code
============================= */
router.post('/send-pin-reset-code', async (req, res) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await User.findOne({ email }).select(
      'email resetCode resetCodeExpires firstName'
    );
    if (!user) return res.status(404).json({ error: 'No account with this email' });

    const now = Date.now();
    // Issue a fresh code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetCode = code;
    user.resetCodeExpires = new Date(now + 15 * 60 * 1000); // 15 minutes
    await user.save();

    await sendSystemEmail({
      to: email,
      subject: 'Research Repository – PIN Reset Code',
      text:
        `Your verification code is: ${code}\n\n` +
        `This code expires in 15 minutes. Do not reply to this email.`,
    });

    return res.json({ message: 'Reset code sent' });
  } catch (err) {
    console.error('❌ send-pin-reset-code error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* =============================
   ✅ Validate reset code (OTP step)
============================= */
router.post('/validate-reset-code', async (req, res) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    const code = String(req.body.code || '').trim();

    if (!email || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Valid email and 6-digit code are required' });
    }

    const user = await User.findOne({ email }).select('resetCode resetCodeExpires email');
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.resetCode || user.resetCode !== code) {
      return res.status(400).json({ error: 'Invalid code' });
    }
    if (!user.resetCodeExpires || user.resetCodeExpires.getTime() < Date.now()) {
      return res.status(400).json({ error: 'Code expired' });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('validate-reset-code error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* =============================
   🔁 Complete reset (after OTP)
============================= */
router.post('/reset-pin', async (req, res) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    const code = String(req.body.code || '').trim();
    const newPin = String(req.body.newPin || '').trim();

    if (!email || !/^\d{6}$/.test(code) || !/^\d{6}$/.test(newPin)) {
      return res
        .status(400)
        .json({ error: 'Valid email, 6-digit code and 6-digit new PIN are required' });
    }

    const user = await User.findOne({ email }).select(
      '+pinHash resetCode resetCodeExpires role firstName lastName college verified'
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.resetCode || user.resetCode !== code) {
      return res.status(400).json({ error: 'Invalid reset code' });
    }
    if (!user.resetCodeExpires || user.resetCodeExpires.getTime() < Date.now()) {
      return res.status(400).json({ error: 'Reset code expired' });
    }

    user.pinHash = await bcrypt.hash(newPin, 10);
    user.resetCode = null;
    user.resetCodeExpires = null;
    await user.save();

    const token = signAuthToken(user);
    return res.json({
      message: 'PIN updated',
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        token,
      },
    });
  } catch (err) {
    console.error('❌ reset-pin error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* =============================
   📧 Verify login code (account verification)
============================= */
router.post('/verify-code', async (req, res) => {
  try {
    let email = String(req.body.email || '').toLowerCase().trim();
    const code = String(req.body.code || '').trim();

    if (!email || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Valid email and 6-digit code are required' });
    }

    const user = await User.findOne({ email }).select(
      'email verified verificationCode firstName lastName role college'
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.verified) return res.status(409).json({ error: 'Account already verified' });
    if (!user.verificationCode)
      return res.status(409).json({ error: 'No active verification code. Please request a new one.' });
    if (user.verificationCode !== code)
      return res.status(400).json({ error: 'Invalid verification code' });

    user.verified = true;
    user.verificationCode = null;
    user.lastVerifiedAt = new Date();
    await user.save();

    const token = signAuthToken(user);
    return res.json({
      message: 'Verification successful',
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        token,
      },
    });
  } catch (err) {
    console.error('❌ Verification error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* =============================
   🔁 Resend verification code
============================= */
router.post('/resend-code', async (req, res) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await User.findOne({ email }).select('email verified');
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.verified) return res.status(409).json({ error: 'Account already verified' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await User.updateOne({ email }, { $set: { verificationCode: code } });

    await sendSystemEmail({
      to: email,
      subject: 'Verify your Research Repository account',
      text: `Your verification code is: ${code}\n\nThis is an automated message.`,
    });

    return res.json({ message: 'Verification code resent' });
  } catch (err) {
    console.error('❌ Resend error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});


/* =============================
   🔁 GET PROFILE (protected)
============================= */
router.get('/me', authorize(), async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-pinHash -verificationCode');
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
  id: user._id,
  firstName: user.firstName,
  lastName: user.lastName,
  fullName: `${user.firstName} ${user.lastName}`,
  email: user.email,
  role: user.role,
  verified: user.verified,
   phone: user.phone || "",                 // ← ADD THIS
  affiliation: user.affiliation || "",
  affiliation: getAffiliation(user.email),
  college: user.college || '',
  createdAt: user.createdAt,
});

  } catch (err) {
    console.error('❌ Fetch /me error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put("/update", authorize(), async (req, res) => {
  try {
    const { firstName, lastName, phone, affiliation, college } = req.body;

    if (!firstName || !lastName) {
      return res.status(400).json({ error: "First and last name required" });
    }

    const updates = {
      firstName,
      lastName,
      phone: phone || "",
      affiliation: affiliation || "",
      college: college || "",
    };

    const user = await User.findByIdAndUpdate(
      req.user.id,
      updates,
      { new: true }
    ).select("-pinHash -verificationCode");

    res.json({ message: "Profile updated", user });

  } catch (err) {
    console.error("UPDATE ERROR:", err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});
// =============================
// 🔐 Change Password (Change PIN)
// =============================
router.put("/change-password", authorize(), async (req, res) => {
  try {
    const { oldPin, newPin } = req.body;

    if (!oldPin || !newPin) {
      return res.status(400).json({ error: "Old PIN and new PIN required" });
    }

    if (!/^\d{6}$/.test(oldPin) || !/^\d{6}$/.test(newPin)) {
      return res.status(400).json({ error: "PIN must be 6 digits" });
    }

    const user = await User.findById(req.user.id).select("+pinHash");
    if (!user) return res.status(404).json({ error: "User not found" });

    // Check if old PIN is correct
    const match = await bcrypt.compare(oldPin, user.pinHash);
    if (!match) return res.status(401).json({ error: "Incorrect old PIN" });

    // Update PIN
    user.pinHash = await bcrypt.hash(newPin, 10);
    await user.save();

    return res.json({ message: "PIN updated successfully" });

  } catch (err) {
    console.error("CHANGE PASSWORD ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});




module.exports = router;
