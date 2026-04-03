const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// ── User Model ────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  username:    { type: String, required: true, unique: true, trim: true, lowercase: true },
  password:    { type: String, required: true },
  email:       { type: String, trim: true, lowercase: true },
  companyName: { type: String, required: true, trim: true },
  role:        { type: String, enum: ['admin', 'client'], default: 'client' },
  isActive:    { type: Boolean, default: true },
  createdAt:   { type: Date, default: Date.now },
  lastLogin:   { type: Date }
}, { timestamps: true });

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function(candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toSafeObject = function() {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

// ── Invoice Model ─────────────────────────────────────────────────────────────
const lineItemSchema = new mongoose.Schema({
  description: String,
  quantity:    Number,
  unitPrice:   Number,
  ourPrice:    { type: Number, default: 0 },
  amount:      Number
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  id:            { type: String, required: true, unique: true },
  fileName:      String,
  invoiceNumber: String,
  clientName:    { type: String, maxlength: 500 },
  date:          String,   // YYYY-MM-DD
  year:          Number,
  month:         Number,
  monthName:     String,
  quarter:       String,
  subtotal:      { type: Number, default: 0 },
  tax:           { type: Number, default: 0 },
  total:         { type: Number, default: 0 },
  currency:      { type: String, default: 'CAD' },
  category:      { type: String, default: 'General' },
  paymentMethod: String,
  hstNumber:     String,
  lineItems:     [lineItemSchema],
  rawTextPreview: String,
  sheetName:     String,
  uploadedAt:    { type: Date, default: Date.now }
}, { timestamps: true });

// Index for fast queries
invoiceSchema.index({ userId: 1, date: -1 });
invoiceSchema.index({ userId: 1, year: 1, month: 1 });

const User    = mongoose.model('User', userSchema);
const Invoice = mongoose.model('Invoice', invoiceSchema);

module.exports = { User, Invoice };
