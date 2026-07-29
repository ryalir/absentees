const mongoose = require('mongoose');

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
  dateOnly: { type: String, required: true } // YYYY-MM-DD format for easy grouping
});

module.exports = mongoose.model('Attendance', attendanceSchema);
