const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connect to MongoDB
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/attendanceDB';
mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB connected successfully.'))
  .catch(err => console.error('MongoDB connection error:', err));

// Attendance Schema & Model
const attendanceSchema = new mongoose.Schema({
  employeeId: { type: String, required: true },
  facultyName: { type: String, required: true },
  subjectName: { type: String, required: true },
  year: { type: String, required: true },
  section: { type: String, required: true },
  period: { type: Number, required: true },
  sessionType: { type: String, required: true },
  absentRollNumbers: [{ type: String }],
  dateOnly: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
});

const Attendance = mongoose.model('Attendance', attendanceSchema);

// Helper: Check if period belongs to Morning session
const isMorningPeriod = (year, period) => (year === 'III' ? period <= 4 : period <= 3);

// -------------------------------------------------------------
// API ENDPOINTS
// -------------------------------------------------------------

// 1. Submit Attendance
app.post('/api/attendance', async (req, res) => {
  try {
    const { employeeId, facultyName, subjectName, year, section, period, sessionType, absentRollNumbers } = req.body;

    if (!employeeId || !facultyName || !subjectName || !year || !section || !period) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    const todayDate = new Date().toISOString().split('T')[0];

    // Duplicate Check
    const existing = await Attendance.findOne({ year, section, period: Number(period), dateOnly: todayDate });
    if (existing) {
      return res.status(400).json({ error: `Attendance for Year ${year}, Section ${section}, Period ${period} has already been posted today.` });
    }

    // Process absent roll numbers
    const processedRolls = absentRollNumbers
      ? absentRollNumbers.split(',').map(r => r.trim()).filter(r => r.length > 0)
      : [];

    const record = new Attendance({
      employeeId,
      facultyName,
      subjectName,
      year,
      section,
      period: Number(period),
      sessionType,
      absentRollNumbers: processedRolls,
      dateOnly: todayDate
    });

    await record.save();
    res.status(201).json({ message: 'Attendance recorded successfully.', record });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Class Daily Report
app.get('/api/reports/daily', async (req, res) => {
  try {
    const { year, section, date } = req.query;
    if (!year || !section || !date) {
      return res.status(400).json({ error: 'year, section, and date query parameters are required.' });
    }

    const records = await Attendance.find({ year, section, dateOnly: date }).sort({ period: 1 });
    res.status(200).json(records);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Student Consolidated Report
app.get('/api/reports/student', async (req, res) => {
  try {
    const { year, section, rollNumber } = req.query;

    if (!year || !section || !rollNumber) {
      return res.status(400).json({ error: 'year, section, and rollNumber are required.' });
    }

    const cleanRoll = rollNumber.trim();
    const classRecords = await Attendance.find({ year, section });

    if (!classRecords || classRecords.length === 0) {
      return res.status(404).json({ error: `No attendance records exist for ${year} Year - Section ${section}.` });
    }

    const distinctTotalDates = [...new Set(classRecords.map(r => r.dateOnly))];
    const totalSessions = distinctTotalDates.length;

    const absentRecords = classRecords.filter(r => 
      Array.isArray(r.absentRollNumbers) && r.absentRollNumbers.includes(cleanRoll)
    );

    const groupedByDate = {};
    absentRecords.forEach(record => {
      const date = record.dateOnly;
      if (!groupedByDate[date]) groupedByDate[date] = [];
      groupedByDate[date].push(Number(record.period));
    });

    const formattedAbsentDetails = Object.keys(groupedByDate).map(date => {
      const sortedPeriods = groupedByDate[date].sort((a, b) => a - b);
      return {
        date,
        periods: sortedPeriods,
        periodCount: sortedPeriods.length
      };
    });

    const totalAbsentSessions = formattedAbsentDetails.length;
    const totalPresentSessions = Math.max(0, totalSessions - totalAbsentSessions);

    const absentPercentage = totalSessions > 0 ? ((totalAbsentSessions / totalSessions) * 100).toFixed(2) + '%' : '0%';
    const presentPercentage = totalSessions > 0 ? ((totalPresentSessions / totalSessions) * 100).toFixed(2) + '%' : '0%';

    res.status(200).json({
      rollNumber: cleanRoll,
      year,
      section,
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

// 4. Frequent Absentees Report (3 consecutive sessions)
app.get('/api/reports/frequent-absentees', async (req, res) => {
  try {
    const { year, section } = req.query;
    if (!year || !section) {
      return res.status(400).json({ error: 'year and section query parameters are required.' });
    }

    const classRecords = await Attendance.find({ year, section }).sort({ dateOnly: 1 });
    const dates = [...new Set(classRecords.map(r => r.dateOnly))].sort();

    const studentAbsences = {};

    dates.forEach(date => {
      const dayRecords = classRecords.filter(r => r.dateOnly === date);
      const morningRecords = dayRecords.filter(r => isMorningPeriod(year, r.period));
      const afternoonRecords = dayRecords.filter(r => !isMorningPeriod(year, r.period));

      const morningAbsent = new Set();
      morningRecords.forEach(r => (r.absentRollNumbers || []).forEach(roll => morningAbsent.add(roll.trim())));

      const afternoonAbsent = new Set();
      afternoonRecords.forEach(r => (r.absentRollNumbers || []).forEach(roll => afternoonAbsent.add(roll.trim())));

      const allRolls = new Set([...morningAbsent, ...afternoonAbsent]);

      allRolls.forEach(roll => {
        if (!studentAbsences[roll]) studentAbsences[roll] = { morning: 0, afternoon: 0, fullDay: 0, flaggedReason: null };

        const isMorn = morningAbsent.has(roll);
        const isAft = afternoonAbsent.has(roll);

        if (isMorn && isAft) {
          studentAbsences[roll].fullDay++;
          studentAbsences[roll].morning++;
          studentAbsences[roll].afternoon++;
        } else if (isMorn) {
          studentAbsences[roll].morning++;
          studentAbsences[roll].fullDay = 0;
        } else if (isAft) {
          studentAbsences[roll].afternoon++;
          studentAbsences[roll].fullDay = 0;
        }

        if (studentAbsences[roll].fullDay >= 3) {
          studentAbsences[roll].flaggedReason = 'Absent 3 consecutive Full-Day sessions';
        } else if (studentAbsences[roll].morning >= 3) {
          studentAbsences[roll].flaggedReason = 'Absent 3 consecutive Morning sessions';
        } else if (studentAbsences[roll].afternoon >= 3) {
          studentAbsences[roll].flaggedReason = 'Absent 3 consecutive Afternoon sessions';
        }
      });
    });

    const frequentAbsentees = [];
    Object.keys(studentAbsences).forEach(roll => {
      if (studentAbsences[roll].flaggedReason) {
        frequentAbsentees.push({ rollNumber: roll, reason: studentAbsences[roll].flaggedReason });
      }
    });

    res.status(200).json(frequentAbsentees);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Morning Present / Afternoon Absent Report
app.get('/api/reports/morning-present-afternoon-absent', async (req, res) => {
  try {
    const { year, section, date } = req.query;

    if (!year || !section || !date) {
      return res.status(400).json({ error: 'year, section, and date are required parameters.' });
    }

    const dayRecords = await Attendance.find({ year, section, dateOnly: date });

    if (!dayRecords || dayRecords.length === 0) {
      return res.status(200).json({ 
        message: `No attendance records submitted for ${year} Year - Section ${section} on ${date}.`,
        students: [] 
      });
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
        const missedAfternoonPeriods = afternoonRecords
          .filter(r => r.absentRollNumbers.includes(rollNumber))
          .map(r => r.period)
          .sort((a, b) => a - b);

        targetStudents.push({ rollNumber, missedAfternoonPeriods });
      }
    });

    res.status(200).json({
      year,
      section,
      date,
      totalFound: targetStudents.length,
      students: targetStudents
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Home Dashboard: Very Frequent Absentees (>= 6 Morning Present & Afternoon Absent Sessions)
app.get('/api/dashboard/frequent-afternoon-absentees', async (req, res) => {
  try {
    const allRecords = await Attendance.find({});

    if (!allRecords || allRecords.length === 0) {
      return res.status(200).json({ totalCount: 0, groupedData: {} });
    }

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
          if (!studentPartDaySessions[studentKey]) {
            studentPartDaySessions[studentKey] = new Set();
          }
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

        groupedData[classGroup].push({
          rollNumber: roll,
          flaggedSessionsCount: sessionCount
        });
        totalCount++;
      }
    });

    res.status(200).json({ totalCount, groupedData });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
