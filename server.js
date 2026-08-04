require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public')); // Serves index.html, sw.js, etc.

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://satyaprasadryali_db_user:XUR8sgUQAc2qdgEp@cluster0.buejm5v.mongodb.net/student_attendance_db?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// VAPID Configuration
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BG2McFBp82prU4M09nH1FxiYhB7HT2Hqf_j2_xe73O20IgcsNYECr9Ca3MxXpskw3KLQSqq-csXwCIw6neYYZto';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'nfkbJtZSt-3KkdArddLHmoVJdYnqKxIiI4NtVGmwDLg';
const VAPID_MAILTO = process.env.VAPID_MAILTO || 'mailto:satyaprasad.ryali@gmail.com';

webpush.setVapidDetails(VAPID_MAILTO, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Database Schemas
const AttendanceSchema = new mongoose.Schema({
  employeeId: String,
  facultyName: String,
  subjectName: String,
  year: String,
  section: String,
  period: Number,
  sessionType: String,
  date: { type: String, default: () => new Date().toISOString().split('T')[0] },
  absentRollNumbers: [String]
});

const PushSubscriptionSchema = new mongoose.Schema({
  endpoint: { type: String, unique: true },
  keys: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now }
});

const Attendance = mongoose.model('Attendance', AttendanceSchema);
const PushSubscription = mongoose.model('PushSubscription', PushSubscriptionSchema);

// API Routes

// 1. Get VAPID Public Key
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// 2. Save Web Push Subscription
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const subscription = req.body;
    await PushSubscription.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      subscription,
      { upsert: true, new: true }
    );
    res.status(201).json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Post Attendance Record
app.post('/api/attendance', async (req, res) => {
  try {
    const { employeeId, facultyName, subjectName, year, section, period, sessionType, absentRollNumbers } = req.body;
    
    const formattedAbsentees = typeof absentRollNumbers === 'string'
      ? absentRollNumbers.split(',').map(s => s.trim()).filter(Boolean)
      : absentRollNumbers;

    const record = new Attendance({
      employeeId,
      facultyName,
      subjectName,
      year,
      section,
      period,
      sessionType,
      absentRollNumbers: formattedAbsentees
    });

    await record.save();
    res.status(201).json({ message: 'Attendance recorded successfully', record });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Daily Class Report
app.get('/api/reports/daily', async (req, res) => {
  try {
    const { year, section, date } = req.query;
    const records = await Attendance.find({ year, section, date }).sort({ period: 1 });
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Missing Attendance Periods Today
app.get('/api/reports/missing-periods', async (req, res) => {
  try {
    const { year, section, date } = req.query;
    const records = await Attendance.find({ year, section, date });
    const postedPeriods = records.map(r => r.period);

    const totalPeriods = (year === 'III') ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5, 6, 7];
    const missingPeriods = totalPeriods.filter(p => !postedPeriods.includes(p));

    res.json({ year, section, date, missingPeriods });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Student Attendance Report
app.get('/api/reports/student', async (req, res) => {
  try {
    const { year, section, rollNumber } = req.query;
    const records = await Attendance.find({ year, section });

    if (!records || records.length === 0) {
      return res.status(404).json({ error: 'No class records found for this Year and Section.' });
    }

    const totalSessions = records.length;
    let absentBreakdownMap = {};

    records.forEach(r => {
      if (r.absentRollNumbers.includes(rollNumber)) {
        if (!absentBreakdownMap[r.date]) {
          absentBreakdownMap[r.date] = [];
        }
        absentBreakdownMap[r.date].push(r.period);
      }
    });

    const absentBreakdown = Object.keys(absentBreakdownMap).map(date => ({
      date,
      periods: absentBreakdownMap[date].sort((a, b) => a - b),
      periodCount: absentBreakdownMap[date].length
    }));

    const totalAbsentSessions = absentBreakdown.length;
    const totalPresentSessions = totalSessions - totalAbsentSessions;

    res.json({
      rollNumber,
      year,
      section,
      totalSessions,
      totalPresentSessions,
      totalAbsentSessions,
      presentPercentage: totalSessions ? ((totalPresentSessions / totalSessions) * 100).toFixed(2) + '%' : '0%',
      absentPercentage: totalSessions ? ((totalAbsentSessions / totalSessions) * 100).toFixed(2) + '%' : '0%',
      absentBreakdown
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Morning Present & Afternoon Absent Report
app.get('/api/reports/morning-present-afternoon-absent', async (req, res) => {
  try {
    const { year, section, date } = req.query;
    const records = await Attendance.find({ year, section, date });

    const morningPeriods = (year === 'III') ? [1, 2, 3, 4] : [1, 2, 3];
    const afternoonPeriods = (year === 'III') ? [5, 6, 7] : [4, 5, 6, 7];

    const morningRecords = records.filter(r => morningPeriods.includes(r.period));
    const afternoonRecords = records.filter(r => afternoonPeriods.includes(r.period));

    let morningAbsentees = new Set();
    morningRecords.forEach(r => r.absentRollNumbers.forEach(roll => morningAbsentees.add(roll)));

    let afternoonAbsentMap = {};
    afternoonRecords.forEach(r => {
      r.absentRollNumbers.forEach(roll => {
        if (!afternoonAbsentMap[roll]) afternoonAbsentMap[roll] = [];
        afternoonAbsentMap[roll].push(r.period);
      });
    });

    let flaggedStudents = [];
    Object.keys(afternoonAbsentMap).forEach(roll => {
      if (!morningAbsentees.has(roll)) {
        flaggedStudents.push({
          rollNumber: roll,
          missedAfternoonPeriods: afternoonAbsentMap[roll].sort((a, b) => a - b)
        });
      }
    });

    res.json({ date, year, section, students: flaggedStudents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Frequent Afternoon Absentees Summary
app.get('/api/dashboard/frequent-afternoon-absentees', async (req, res) => {
  try {
    const records = await Attendance.find({});
    let studentStats = {};

    records.forEach(r => {
      const isAfternoon = (r.year === 'III' && r.period >= 5) || (r.year === 'IV' && r.period >= 4);
      if (isAfternoon) {
        r.absentRollNumbers.forEach(roll => {
          const key = `${r.year}-${r.section}:${roll}`;
          if (!studentStats[key]) {
            studentStats[key] = { classGroup: `${r.year} Year - Section ${r.section}`, rollNumber: roll, flaggedSessionsCount: 0 };
          }
          studentStats[key].flaggedSessionsCount++;
        });
      }
    });

    let groupedData = {};
    let totalCount = 0;

    Object.values(studentStats).forEach(st => {
      if (st.flaggedSessionsCount >= 6) {
        if (!groupedData[st.classGroup]) groupedData[st.classGroup] = [];
        groupedData[st.classGroup].push(st);
        totalCount++;
      }
    });

    res.json({ totalCount, groupedData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
