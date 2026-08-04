const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const webpush = require('web-push');

const app = express();

// ==========================================
// MIDDLEWARES
// ==========================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// MONGODB CONFIGURATION & CONNECTION
// ==========================================
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://satyaprasadryali_db_user:XUR8sgUQAc2qdgEp@cluster0.buejm5v.mongodb.net/student_attendance_db?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB Atlas: student_attendance_db'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

const attendanceSchema = new mongoose.Schema(
  {
    employeeId: { type: String, required: true },
    facultyName: { type: String, required: true },
    subjectName: { type: String, required: true },
    year: { type: String, enum: ['III', 'IV'], required: true },
    section: { type: String, required: true },
    period: { type: Number, required: true },
    sessionType: { type: String, enum: ['Morning', 'Afternoon'], required: true },
    absentRollNumbers: [{ type: String, trim: true }],
    dateTimeRecorded: { type: Date, default: Date.now },
    dateOnly: { type: String, required: true }
  },
  { collection: 'attendance' }
);

const Attendance = mongoose.model('Attendance', attendanceSchema, 'attendance');

// Schema for Push Subscriptions
const subscriptionSchema = new mongoose.Schema({
  endpoint: { type: String, required: true, unique: true },
  keys: {
    p256dh: String,
    auth: String
  }
});
const Subscription = mongoose.model('Subscription', subscriptionSchema);

const isMorningPeriod = (year, period) => (year === 'III' ? period <= 4 : period <= 3);

// ==========================================
// WEB PUSH CONFIGURATION
// ==========================================
const PUBLIC_VAPID_KEY = process.env.VAPID_PUBLIC_KEY;
const PRIVATE_VAPID_KEY = process.env.VAPID_PRIVATE_KEY;

if (PUBLIC_VAPID_KEY && PRIVATE_VAPID_KEY) {
  webpush.setVapidDetails(
    'mailto:satyaprasad.ryali@gmail.com',
    PUBLIC_VAPID_KEY,
    PRIVATE_VAPID_KEY
  );
} else {
  console.warn("⚠️ VAPID Keys not provided in environment variables!");
}

// Endpoint to fetch public key on client side
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: PUBLIC_VAPID_KEY || '' });
});

// Endpoint to save push subscriptions
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const subscription = req.body;
    await Subscription.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      subscription,
      { upsert: true, new: true }
    );
    res.status(201).json({ message: 'Push subscription saved successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Function to check missing attendance and issue notifications
async function checkAndSendMissingAttendanceNotifications() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const classes = [
      ...['A','B','C','D','E','F','G','H'].map(s => ({ year: 'III', section: s })),
      ...['A','B','C','D','E','F'].map(s => ({ year: 'IV', section: s }))
    ];

    let missingCount = 0;
    const missingDetails = [];

    for (const cls of classes) {
      const totalPeriods = [1, 2, 3, 4, 5, 6, 7];
      const records = await Attendance.find({ year: cls.year, section: cls.section, dateOnly: today }, { period: 1 });
      const posted = records.map(r => Number(r.period));
      const missing = totalPeriods.filter(p => !posted.includes(p));

      if (missing.length > 0) {
        missingCount++;
        missingDetails.push(`${cls.year}-${cls.section}: P(${missing.join(',')})`);
      }
    }

    if (missingCount === 0) return;

    const payload = JSON.stringify({
      title: '🚨 Missing Attendance Alert',
      body: `${missingCount} Class Sections have missing attendance entries for today!`,
      url: '/'
    });

    const subscriptions = await Subscription.find({});
    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await Subscription.deleteOne({ _id: sub._id });
        }
      }
    }
  } catch (err) {
    console.error('Error running cron job notification:', err);
  }
}

// CRON JOB 1: Every 50 mins from 10:20 AM to 04:10 PM (10:20, 11:10, 12:00, 12:50, 13:40, 14:30, 15:20, 16:10)
cron.schedule('20 10 * * *', checkAndSendMissingAttendanceNotifications);
cron.schedule('10 11 * * *', checkAndSendMissingAttendanceNotifications);
cron.schedule('0 12 * * *', checkAndSendMissingAttendanceNotifications);
cron.schedule('50 12 * * *', checkAndSendMissingAttendanceNotifications);
cron.schedule('40 13 * * *', checkAndSendMissingAttendanceNotifications);
cron.schedule('30 14 * * *', checkAndSendMissingAttendanceNotifications);
cron.schedule('20 15 * * *', checkAndSendMissingAttendanceNotifications);
cron.schedule('10 16 * * *', checkAndSendMissingAttendanceNotifications);

// CRON JOB 2: Every 5 mins from 04:15 PM to 04:30 PM (16:15, 16:20, 16:25, 16:30)
cron.schedule('15-30/5 16 * * *', checkAndSendMissingAttendanceNotifications);

// ==========================================
// EXISTING ATTENDANCE & REPORT API ROUTES
// ==========================================
app.post('/api/attendance', async (req, res) => {
  try {
    const { employeeId, facultyName, subjectName, year, section, period, sessionType, absentRollNumbers } = req.body;
    const now = new Date();
    const dateOnly = now.toISOString().split('T')[0];

    const existingEntry = await Attendance.findOne({ year, section, period: Number(period), dateOnly });
    if (existingEntry) {
      return res.status(400).json({ error: `Attendance for Year ${year}, Section ${section}, Period ${period} has already been posted today.` });
    }

    const absentList = typeof absentRollNumbers === 'string'
      ? absentRollNumbers.split(',').map(roll => roll.trim()).filter(Boolean)
      : (Array.isArray(absentRollNumbers) ? absentRollNumbers : []);

    const record = new Attendance({
      employeeId, facultyName, subjectName, year, section,
      period: Number(period), sessionType, absentRollNumbers: absentList,
      dateTimeRecorded: now, dateOnly
    });

    const savedRecord = await record.save();
    res.status(201).json({ message: 'Attendance recorded successfully!', record: savedRecord });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/daily', async (req, res) => {
  try {
    const { year, section, date } = req.query;
    if (!year || !section || !date) return res.status(400).json({ error: 'year, section, and date query parameters are required.' });
    const records = await Attendance.find({ year, section, dateOnly: date }).sort({ period: 1 });
    res.status(200).json(records);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/student', async (req, res) => {
  try {
    const { year, section, rollNumber } = req.query;
    if (!year || !section || !rollNumber) return res.status(400).json({ error: 'year, section, and rollNumber are required parameters.' });

    const cleanRoll = rollNumber.trim();
    const classRecords = await Attendance.find({ year, section });
    if (!classRecords || classRecords.length === 0) return res.status(404).json({ error: `No attendance records exist for ${year} Year - Section ${section}.` });

    const distinctTotalDates = [...new Set(classRecords.map(r => r.dateOnly))];
    const totalSessions = distinctTotalDates.length;
    const absentRecords = classRecords.filter(r => Array.isArray(r.absentRollNumbers) && r.absentRollNumbers.includes(cleanRoll));

    const groupedByDate = {};
    absentRecords.forEach(record => {
      const date = record.dateOnly;
      if (!groupedByDate[date]) groupedByDate[date] = [];
      groupedByDate[date].push(Number(record.period));
    });

    const formattedAbsentDetails = Object.keys(groupedByDate).map(date => {
      const sortedPeriods = groupedByDate[date].sort((a, b) => a - b);
      return { date, periods: sortedPeriods, periodCount: sortedPeriods.length };
    });

    const totalAbsentSessions = formattedAbsentDetails.length;
    const totalPresentSessions = Math.max(0, totalSessions - totalAbsentSessions);

    res.status(200).json({
      rollNumber: cleanRoll, year, section, totalSessions, totalAbsentSessions, totalPresentSessions,
      absentPercentage: totalSessions > 0 ? ((totalAbsentSessions / totalSessions) * 100).toFixed(2) + '%' : '0%',
      presentPercentage: totalSessions > 0 ? ((totalPresentSessions / totalSessions) * 100).toFixed(2) + '%' : '0%',
      absentBreakdown: formattedAbsentDetails
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/frequent-absentees', async (req, res) => {
  try {
    const { year, section } = req.query;
    if (!year || !section) return res.status(400).json({ error: 'year and section parameters are required.' });

    const distinctDates = await Attendance.distinct('dateOnly', { year, section });
    distinctDates.sort();
    if (distinctDates.length === 0) return res.status(200).json([]);

    const allRecords = await Attendance.find({ year, section });
    const allRolls = new Set();
    allRecords.forEach(r => r.absentRollNumbers.forEach(roll => allRolls.add(roll.trim())));

    const frequentAbsentees = [];
    allRolls.forEach(rollNumber => {
      let streakCount = 0, streakStartDate = null, streakStartSession = null, flagged = false, flagReason = '';

      for (const date of distinctDates) {
        if (flagged) break;
        const dayRecords = allRecords.filter(r => r.dateOnly === date);

        const isAbsentMorning = dayRecords.some(r => isMorningPeriod(year, r.period) && r.absentRollNumbers.includes(rollNumber));
        if (isAbsentMorning) {
          streakCount++;
          if (streakCount === 1) { streakStartDate = date; streakStartSession = 'Morning'; }
          if (streakCount >= 3) { flagged = true; flagReason = `Absent for 3 consecutive sessions starting on ${streakStartDate} (${streakStartSession} session)`; break; }
        } else { streakCount = 0; }

        const isAbsentAfternoon = dayRecords.some(r => !isMorningPeriod(year, r.period) && r.absentRollNumbers.includes(rollNumber));
        if (isAbsentAfternoon) {
          streakCount++;
          if (streakCount === 1) { streakStartDate = date; streakStartSession = 'Afternoon'; }
          if (streakCount >= 3) { flagged = true; flagReason = `Absent for 3 consecutive sessions starting on ${streakStartDate} (${streakStartSession} session)`; break; }
        } else { streakCount = 0; }
      }

      if (flagged) frequentAbsentees.push({ rollNumber, reason: flagReason });
    });

    res.status(200).json(frequentAbsentees);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/morning-present-afternoon-absent', async (req, res) => {
  try {
    const { year, section, date } = req.query;
    if (!year || !section || !date) return res.status(400).json({ error: 'year, section, and date are required parameters.' });

    const dayRecords = await Attendance.find({ year, section, dateOnly: date });
    if (!dayRecords || dayRecords.length === 0) {
      return res.status(200).json({ message: `No attendance records submitted for ${year} Year - Section ${section} on ${date}.`, students: [] });
    }

    const morningRecords = dayRecords.filter(r => isMorningPeriod(year, r.period));
    const afternoonRecords = dayRecords.filter(r => !isMorningPeriod(year, r.period));

    const afternoonAbsentRolls = new Set();
    afternoonRecords.forEach(r => (r.absentRollNumbers || []).forEach(roll => afternoonAbsentRolls.add(roll.trim())));

    const morningAbsentRolls = new Set();
    morningRecords.forEach(r => (r.absentRollNumbers || []).forEach(roll => morningAbsentRolls.add(roll.trim())));

    const targetStudents = [];
    afternoonAbsentRolls.forEach(rollNumber => {
      if (!morningAbsentRolls.has(rollNumber)) {
        const missedAfternoonPeriods = afternoonRecords.filter(r => r.absentRollNumbers.includes(rollNumber)).map(r => r.period).sort((a, b) => a - b);
        targetStudents.push({ rollNumber, missedAfternoonPeriods });
      }
    });

    res.status(200).json({ year, section, date, totalFound: targetStudents.length, students: targetStudents });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/dashboard/frequent-afternoon-absentees', async (req, res) => {
  try {
    const allRecords = await Attendance.find({});
    if (!allRecords || allRecords.length === 0) return res.status(200).json({ totalCount: 0, groupedData: {} });

    const studentPartDaySessions = {};
    const recordsByDay = {};

    allRecords.forEach(r => {
      const key = `${r.year}_${r.section}_${r.dateOnly}`;
      if (!recordsByDay[key]) recordsByDay[key] = [];
      recordsByDay[key].push(r);
    });

    Object.keys(recordsByDay).forEach(key => {
      const [year, section, date] = key.split('_');
      const dayRecords = recordsByDay[key];

      const morningRecords = dayRecords.filter(r => isMorningPeriod(year, r.period));
      const afternoonRecords = dayRecords.filter(r => !isMorningPeriod(year, r.period));

      const morningAbsentRolls = new Set();
      morningRecords.forEach(r => (r.absentRollNumbers || []).forEach(roll => morningAbsentRolls.add(roll.trim())));

      const afternoonAbsentRolls = new Set();
      afternoonRecords.forEach(r => (r.absentRollNumbers || []).forEach(roll => afternoonAbsentRolls.add(roll.trim())));

      afternoonAbsentRolls.forEach(roll => {
        if (!morningAbsentRolls.has(roll)) {
          const studentKey = `${year}_${section}_${roll}`;
          if (!studentPartDaySessions[studentKey]) studentPartDaySessions[studentKey] = new Set();
          studentPartDaySessions[studentKey].add(date);
        }
      });
    });

    const groupedData = {};
    let totalCount = 0;

    Object.keys(studentPartDaySessions).forEach(studentKey => {
      const [year, section, roll] = studentKey.split('_');
      const sessionCount = studentPartDaySessions[studentKey].size;

      if (sessionCount >= 6) {
        const classGroup = `${year} Year - Section ${section}`;
        if (!groupedData[classGroup]) groupedData[classGroup] = [];
        groupedData[classGroup].push({ rollNumber: roll, flaggedSessionsCount: sessionCount });
        totalCount++;
      }
    });

    res.status(200).json({ totalCount, groupedData });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/missing-periods', async (req, res) => {
  try {
    const { year, section, date } = req.query;
    if (!year || !section || !date) return res.status(400).json({ error: "year, section and date are required." });

    const totalPeriods = [1, 2, 3, 4, 5, 6, 7];
    const records = await Attendance.find({ year, section, dateOnly: date }, { period: 1, _id: 0 });
    const postedPeriods = records.map(r => Number(r.period)).sort((a, b) => a - b);
    const missingPeriods = totalPeriods.filter(p => !postedPeriods.includes(p));

    res.status(200).json({
      year, section, date, totalPeriods: totalPeriods.length,
      postedPeriods, missingPeriods, attendanceComplete: missingPeriods.length === 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
