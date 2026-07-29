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

    if (!year || !section || !rollNumber) {
      return res.status(400).json({ error: 'year, section, and rollNumber are required.' });
    }

    const cleanRoll = rollNumber.trim();

    // 1. Fetch total distinct dates where attendance was posted for this year & section
    const distinctTotalDates = await Attendance.distinct('dateOnly', { year, section });
    const totalSessions = distinctTotalDates.length;

    // 2. Find all attendance documents where this student was marked absent
    const records = await Attendance.find({
      year,
      section,
      absentRollNumbers: cleanRoll
    }).sort({ dateOnly: 1, period: 1 });

    // 3. Group absent records by Date
    const groupedByDate = {};

    records.forEach(record => {
      const date = record.dateOnly;
      if (!groupedByDate[date]) {
        groupedByDate[date] = [];
      }
      groupedByDate[date].push(Number(record.period));
    });

    // 4. Format date summary & calculate totals
    const formattedAbsentDetails = Object.keys(groupedByDate).map(date => {
      // Sort period numbers in ascending order (e.g. [1, 4, 5])
      const sortedPeriods = groupedByDate[date].sort((a, b) => a - b);
      return {
        date: date,
        periods: sortedPeriods, // Array of absent periods
        periodCount: sortedPeriods.length
      };
    });

    // Each unique absent date counts as 1 absent session
    const totalAbsentSessions = formattedAbsentDetails.length;
    const totalPresentSessions = Math.max(0, totalSessions - totalAbsentSessions);

    const absentPercentage = totalSessions > 0 
      ? ((totalAbsentSessions / totalSessions) * 100).toFixed(2) + '%' 
      : '0%';
      
    const presentPercentage = totalSessions > 0 
      ? ((totalPresentSessions / totalSessions) * 100).toFixed(2) + '%' 
      : '0%';

    res.status(200).json({
      rollNumber: cleanRoll,
      totalSessions,
      totalAbsentSessions,
      totalPresentSessions,
      absentPercentage,
      presentPercentage,
      absentBreakdown: formattedAbsentDetails
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Frequent Absentees Report GET API (3 Consecutive Days Rule)
app.get('/api/reports/frequent-absentees', async (req, res) => {
  try {
    const { year, section } = req.query;

    if (!year || !section) {
      return res.status(400).json({ error: 'year and section parameters are required.' });
    }

    // 1. Fetch all distinct dates attendance was taken for this year/section
    const distinctDates = await Attendance.distinct('dateOnly', { year, section });
    distinctDates.sort(); // Sort dates chronologically (oldest to newest)

    if (distinctDates.length === 0) {
      return res.status(200).json([]);
    }

    // 2. Fetch all attendance records for this year & section
    const allRecords = await Attendance.find({ year, section });

    // 3. Extract all unique student roll numbers present across all records
    const allRolls = new Set();
    allRecords.forEach(r => {
      r.absentRollNumbers.forEach(roll => allRolls.add(roll.trim()));
    });

    const frequentAbsentees = [];

    // Define Morning vs Afternoon period thresholds
    const isMorningPeriod = (period) => (year === 'III' ? period <= 4 : period <= 3);

    // 4. Evaluate each student's sequential session history
    allRolls.forEach(rollNumber => {
      let streakCount = 0;
      let streakStartDate = null;
      let streakStartSession = null;
      let flagged = false;
      let flagReason = '';

      // Loop chronologically date by date
      for (const date of distinctDates) {
        if (flagged) break; // Stop checking once flagged for 3 consecutive absent sessions

        const dayRecords = allRecords.filter(r => r.dateOnly === date);

        // Determine Morning Session status
        const isAbsentMorning = dayRecords.some(r => isMorningPeriod(r.period) && r.absentRollNumbers.includes(rollNumber));

        // Process Morning Session
        if (isAbsentMorning) {
          streakCount++;
          if (streakCount === 1) {
            streakStartDate = date;
            streakStartSession = 'Morning';
          }
          if (streakCount >= 3) {
            flagged = true;
            flagReason = `Absent for 3 consecutive sessions starting on ${streakStartDate} (${streakStartSession} session)`;
            break;
          }
        } else {
          streakCount = 0; // Reset streak if present
        }

        // Determine Afternoon Session status
        const isAbsentAfternoon = dayRecords.some(r => !isMorningPeriod(r.period) && r.absentRollNumbers.includes(rollNumber));

        // Process Afternoon Session
        if (isAbsentAfternoon) {
          streakCount++;
          if (streakCount === 1) {
            streakStartDate = date;
            streakStartSession = 'Afternoon';
          }
          if (streakCount >= 3) {
            flagged = true;
            flagReason = `Absent for 3 consecutive sessions starting on ${streakStartDate} (${streakStartSession} session)`;
            break;
          }
        } else {
          streakCount = 0; // Reset streak if present
        }
      }

      if (flagged) {
        frequentAbsentees.push({
          rollNumber,
          reason: flagReason
        });
      }
    });

    res.status(200).json(frequentAbsentees);

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
