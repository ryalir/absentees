const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();

// ==========================================
// MIDDLEWARES
// MUST be registered before declaring routes
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

// Schema & Collection Mapping
const attendanceSchema = new mongoose.Schema({
  employeeId: { type: String, required: true },
  facultyName: { type: String, required: true },
  subjectName: { type: String, required: true },
  year: { type: String, enum: ['III', 'IV'], required: true },
  section: { type: String, required: true },
  period: { type: Number, required: true },
  sessionType: { type: String, enum: ['Morning', 'Afternoon'], required: true },
  absentRollNumbers: [{ type: String, trim: true }],
  dateTimeRecorded: { type: Date, default: Date.now },
  dateOnly: { type: String, required: true } // YYYY-MM-DD
});

// Explicitly bind schema to 'attendance' collection in 'student_attendance_db'
const Attendance = mongoose.model('Attendance', attendanceSchema, 'attendance');

// ==========================================
// API ROUTES
// ==========================================

// 1. Submit Attendance POST API
app.post('/api/attendance', async (req, res) => {
  try {
    const { employeeId, facultyName, subjectName, year, section, period, sessionType, absentRollNumbers } = req.body;

    const now = new Date();
    const dateOnly = now.toISOString().split('T')[0];

    // Check if attendance for this year, section, period, and date already exists
    const existingEntry = await Attendance.findOne({
      year,
      section,
      period: Number(period),
      dateOnly
    });

    if (existingEntry) {
      return res.status(400).json({ 
        error: `Attendance for Year ${year}, Section ${section}, Period ${period} has already been posted today.` 
      });
    }

    const absentList = typeof absentRollNumbers === 'string'
      ? absentRollNumbers.split(',').map(roll => roll.trim()).filter(Boolean)
      : (Array.isArray(absentRollNumbers) ? absentRollNumbers : []);

    const record = new Attendance({
      employeeId,
      facultyName,
      subjectName,
      year,
      section,
      period: Number(period),
      sessionType,
      absentRollNumbers: absentList,
      dateTimeRecorded: now,
      dateOnly
    });

    const savedRecord = await record.save();
    res.status(201).json({ message: 'Attendance recorded successfully!', record: savedRecord });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Class Daily Report GET API
app.get('/api/reports/daily', async (req, res) => {
  try {
    const { year, section, date } = req.query;

    if (!year || !section || !date) {
      return res.status(400).json({ error: 'year, section, and date query parameters are required.' });
    }

    // Find attendance records matching year, section, and date
    const records = await Attendance.find({
      year: year,
      section: section,
      dateOnly: date
    }).sort({ period: 1 }); // Sort chronologically by Period (1, 2, 3...)

    res.status(200).json(records);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Consolidated Student Report GET API
app.get('/api/reports/student', async (req, res) => {
  try {
    const { year, section, rollNumber } = req.query;

    const totalSessions = await Attendance.countDocuments({ year, section });

    const absentSessions = await Attendance.find({
      year,
      section,
      absentRollNumbers: rollNumber
    }).sort({ dateTimeRecorded: -1 });

    const totalAbsent = absentSessions.length;
    const totalPresent = totalSessions - totalAbsent;

    const presentPercentage = totalSessions > 0 ? ((totalPresent / totalSessions) * 100).toFixed(2) : '0.00';
    const absentPercentage = totalSessions > 0 ? ((totalAbsent / totalSessions) * 100).toFixed(2) : '0.00';

    const absentDetails = absentSessions.map(s => ({
      date: s.dateOnly,
      period: s.period,
      sessionType: s.sessionType,
      subject: s.subjectName,
      faculty: s.facultyName
    }));

    res.json({
      rollNumber,
      totalSessions,
      totalPresent,
      totalAbsent,
      presentPercentage: `${presentPercentage}%`,
      absentPercentage: `${absentPercentage}%`,
      absentDetails
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Frequent Absentees Report GET API (3 Consecutive Days Rule)
app.get('/api/reports/frequent-absentees', async (req, res) => {
  try {
    const { year, section } = req.query;
    const records = await Attendance.find({ year, section }).sort({ dateOnly: 1 });

    const studentDates = {};

    records.forEach(rec => {
      rec.absentRollNumbers.forEach(roll => {
        if (!studentDates[roll]) studentDates[roll] = {};
        if (!studentDates[roll][rec.dateOnly]) studentDates[roll][rec.dateOnly] = new Set();
        studentDates[roll][rec.dateOnly].add(rec.sessionType);
      });
    });

    const frequentAbsentees = [];

    const isConsecutive = (d1, d2) => {
      const diff = (new Date(d2) - new Date(d1)) / (1000 * 60 * 60 * 24);
      return diff === 1;
    };

    for (const [roll, datesMap] of Object.entries(studentDates)) {
      const dates = Object.keys(datesMap).sort();
      let streakMorning = 0;
      let streakAfternoon = 0;
      let streakFullDay = 0;

      let isFlagged = false;
      let flagReason = '';

      for (let i = 0; i < dates.length; i++) {
        const currentDate = dates[i];
        const sessions = datesMap[currentDate];
        const hasMorning = sessions.has('Morning');
        const hasAfternoon = sessions.has('Afternoon');
        const isFullDay = hasMorning && hasAfternoon;

        if (i === 0 || isConsecutive(dates[i - 1], currentDate)) {
          streakMorning = hasMorning ? streakMorning + 1 : 0;
          streakAfternoon = hasAfternoon ? streakAfternoon + 1 : 0;
          streakFullDay = isFullDay ? streakFullDay + 1 : 0;
        } else {
          streakMorning = hasMorning ? 1 : 0;
          streakAfternoon = hasAfternoon ? 1 : 0;
          streakFullDay = isFullDay ? 1 : 0;
        }

        if (streakFullDay >= 3) {
          isFlagged = true;
          flagReason = 'Absent for 3 Consecutive Full Days';
          break;
        } else if (streakMorning >= 3) {
          isFlagged = true;
          flagReason = 'Absent for 3 Consecutive Morning Sessions';
          break;
        } else if (streakAfternoon >= 3) {
          isFlagged = true;
          flagReason = 'Absent for 3 Consecutive Afternoon Sessions';
          break;
        }
      }

      if (isFlagged) {
        frequentAbsentees.push({ rollNumber: roll, reason: flagReason });
      }
    }

    res.json(frequentAbsentees);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fallback Route for Single Page App
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Dynamic Port Binding
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
