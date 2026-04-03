const router = require('express').Router();
const { User, Invoice } = require('../models');
const { authenticate, adminOnly } = require('../middleware/auth');

router.use(authenticate, adminOnly);

// ── Get all users ─────────────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Create user (admin creates client) ───────────────────────────────────────
router.post('/users', async (req, res) => {
  try {
    const { username, password, email, companyName, role } = req.body;
    if (!username || !password || !companyName)
      return res.status(400).json({ error: 'Username, password, company name required' });

    const exists = await User.findOne({ username: username.toLowerCase().trim() });
    if (exists) return res.status(409).json({ error: 'Username already taken' });

    const user = await User.create({ username, password, email, companyName, role: role || 'client' });
    res.json({ ok: true, user: user.toSafeObject() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Toggle user active/inactive ───────────────────────────────────────────────
router.patch('/users/:id/toggle', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.isActive = !user.isActive;
    await user.save();
    res.json({ ok: true, isActive: user.isActive });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Delete user + their invoices ──────────────────────────────────────────────
router.delete('/users/:id', async (req, res) => {
  try {
    await Invoice.deleteMany({ userId: req.params.id });
    await User.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Platform stats ────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [totalUsers, totalInvoices, revenueResult] = await Promise.all([
      User.countDocuments({ role: 'client' }),
      Invoice.countDocuments(),
      Invoice.aggregate([{ $group: { _id: null, total: { $sum: '$total' }, tax: { $sum: '$tax' } } }])
    ]);

    // Per-client stats
    const clientStats = await Invoice.aggregate([
      { $group: {
        _id: '$userId',
        invoiceCount: { $sum: 1 },
        totalRevenue: { $sum: '$total' },
        lastInvoice:  { $max: '$date' }
      }},
      { $sort: { totalRevenue: -1 } }
    ]);

    const userIds = clientStats.map(c => c._id);
    const users = await User.find({ _id: { $in: userIds } }).select('username companyName');
    const userMap = {};
    users.forEach(u => { userMap[u._id.toString()] = u; });

    const clientData = clientStats.map(c => ({
      ...c,
      user: userMap[c._id?.toString()] || null
    }));

    res.json({
      totalUsers,
      totalInvoices,
      totalRevenue: revenueResult[0]?.total || 0,
      totalTax:     revenueResult[0]?.tax || 0,
      clientData
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
