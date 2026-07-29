const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const Attendance = require('./models/Attendance');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// UPDATE YOUR MONGO CONNECTION STRING HERE
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/student_attendance_db';

mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB Connected Successfully'))
  .catch(err => console.error('MongoDB Connection Error:', err));

// 1. Submit Attendance API
app.post('/api/attendance', async (req, res) => {
  try {
    const { employeeId, facultyName, subjectName, year, section, period, sessionType, absentRollNumbers } = req.body;
    
    // Parse comma-separated list
    const absentList = absentRollNumbers
      ? absentRollNumbers.split(',').map(roll => roll.trim()).filter(Boolean)
      : [];

    const now = new Date();
    const dateOnly = now.toISOString().split('T')[0];

    const record = new Attendance({
      employeeId,
      facultyName,
      subjectName,
      year,
      section,
      period,
      sessionType,
      absentRollNumbers: absentList,
      dateTimeRecorded: now,
      dateOnly
    });

    await record.save();
    res.status(201).json({ message: 'Attendance recorded successfully!', record });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Class Daily Report API
app.get('/api/reports/daily', async (req, res) => {
  try {
    const { year, section, date } = req.query;
    const records = await Attendance.find({ year, section, dateOnly: date }).sort({ period: 1 });
    res.json(records);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Consolidated Student Report API
app.get('/api/reports/student', async (req, res) => {
  try {
    const { year, section, rollNumber } = req.query;
    
    // Get total class sessions conducted for this year and section
    const totalSessions = await Attendance.countDocuments({ year, section });
    
    // Find sessions where the student was absent
    const absentSessions = await Attendance.find({
      year,
      section,
      absentRollNumbers: rollNumber
    }).sort({ dateTimeRecorded: -1 });

    const totalAbsent = absentSessions.length;
    const totalPresent = totalSessions - totalAbsent;
    
    const presentPercentage = totalSessions > 0 ? ((totalPresent / totalSessions) * 100).toFixed(2) : 0;
    const absentPercentage = totalSessions > 0 ? ((totalAbsent / totalSessions) * 100).toFixed(2) : 0;

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

// 4. Frequent Absentees API (3 Consecutive Days in Morning/Afternoon/Full Day)
app.get('/api/reports/frequent-absentees', async (req, res) => {
  try {
    const { year, section } = req.query;
    const records = await Attendance.find({ year, section }).sort({ dateOnly: 1 });

    // Group absent instances by date and student
    const studentDates = {}; // { rollNo: { 'YYYY-MM-DD': Set(['Morning', 'Afternoon']) } }

    records.forEach(rec => {
      rec.absentRollNumbers.forEach(roll => {
        if (!studentDates[roll]) studentDates[roll] = {};
        if (!studentDates[roll][rec.dateOnly]) studentDates[roll][rec.dateOnly] = new Set();
        studentDates[roll][rec.dateOnly].add(rec.sessionType);
      });
    });

    const frequentAbsentees = [];

    // Helper to check 3 consecutive dates
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));