// models/User.js
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName:  { type: String, required: true, trim: true },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      validate: {
        // ✅ Students, faculty, and staff all use @g.msuiit.edu.ph
        validator: (v) => /@g\.msuiit\.edu\.ph$/i.test(v),
        message: "Only @g.msuiit.edu.ph emails are allowed",
      },
      index: true,
    },

     // ADD THIS ➜ phone number
    phone: { type: String, default: "" },

    // ADD THIS ➜ so updated affiliation is saved
    affiliation: { type: String, default: "" },

    pinHash: { type: String, required: true, select: false },

    role: {
      type: String,
      enum: ["student", "staff", "faculty", "admin"],
      default: "student",
      index: true,
    },

    college: { type: String, default: "" },

    verified:         { type: Boolean, default: false },
    verificationCode: { type: String, default: null, select: false },
    lastVerifiedAt:   { type: Date, default: null },

    resetCode:        { type: String, default: null, select: false },
    resetCodeExpires: { type: Date,   default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        delete ret.pinHash;
        delete ret.verificationCode;
        delete ret.resetCode;
        return ret;
      },
    },
  }
);

userSchema.pre("save", function (next) {
  if (this.email) this.email = String(this.email).toLowerCase();
  next();
});

module.exports = mongoose.models.User || mongoose.model("User", userSchema);
