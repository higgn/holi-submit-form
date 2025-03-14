const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { GridFSBucket, ObjectId } = require('mongodb');
const app = express();
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 3000;

// MongoDB connection
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    // Initialize GridFS bucket
    const db = mongoose.connection.db;
    fileBucket = new GridFSBucket(db, { bucketName: 'uploads' });
  })
  .catch(err => console.error('MongoDB connection error:', err));

// Set up memory storage for multer (temporary before storing in GridFS)
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    // Allow all file types for now - you can restrict if needed
    cb(null, true);
  }
});

// MongoDB Schema and Model
const submissionSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  class: { type: String, required: true },
  fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
  originalFileName: { type: String, required: true },
  contentType: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const Submission = mongoose.model('Submission', submissionSchema);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Authentication middleware
const authenticate = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (err) {
        return res.status(401).json({ message: 'Invalid token' });
      }
      req.user = decoded;
      next();
    });
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({ message: 'Authentication failed' });
  }
};

// Routes
// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve admin page
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Handle form submission
app.post('/api/submit', upload.single('fileUpload'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const { name, phone, class: studentClass } = req.body;
    
    // Store file in GridFS
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const uploadStream = fileBucket.openUploadStream(
      uniqueSuffix + '-' + req.file.originalname,
      {
        contentType: req.file.mimetype,
        metadata: {
          originalFileName: req.file.originalname,
          uploader: name
        }
      }
    );
    
    uploadStream.end(req.file.buffer);
    
    // Wait for the upload to complete
    await new Promise((resolve, reject) => {
      uploadStream.on('finish', resolve);
      uploadStream.on('error', reject);
    });

    // Create new submission
    const submission = new Submission({
      name,
      phone,
      class: studentClass,
      fileId: uploadStream.id,
      originalFileName: req.file.originalname,
      contentType: req.file.mimetype
    });

    await submission.save();
    res.status(201).json({ 
      message: 'Submission successful',
      submission: {
        id: submission._id,
        name: submission.name
      }
    });
  } catch (error) {
    console.error('Submission error:', error);
    res.status(500).json({ message: 'Submission failed' });
  }
});

// Admin login
app.post('/api/login', async (req, res) => {
  try {
    const { password } = req.body;
    
    // In a real application, you would hash and compare passwords
    // For this demo, we're using a simple string comparison
    if (password === process.env.ADMIN_PASSWORD) {
      // Generate JWT token
      const token = jwt.sign({
        admin: true
      }, JWT_SECRET, { expiresIn: '24h' });
      
      res.json({ token });
    } else {
      res.status(401).json({ message: 'Invalid credentials' });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Login failed' });
  }
});

// Get all submissions (protected route)
app.get('/api/submissions', authenticate, async (req, res) => {
  try {
    const submissions = await Submission.find().sort({ createdAt: -1 });
    res.json(submissions);
  } catch (error) {
    console.error('Error fetching submissions:', error);
    res.status(500).json({ message: 'Failed to fetch submissions' });
  }
});

// Download file (protected route)
app.get('/api/download/:id', authenticate, async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id);
    if (!submission) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    const downloadStream = fileBucket.openDownloadStream(submission.fileId);
    
    // Set appropriate headers for file download
    res.set({
      'Content-Type': submission.contentType,
      'Content-Disposition': `attachment; filename="${submission.originalFileName}"`,
    });

    // Pipe the file stream to the response
    downloadStream.pipe(res);
    
    // Handle any errors
    downloadStream.on('error', (err) => {
      console.error('Download stream error:', err);
      // If the response hasn't been sent yet, send an error response
      if (!res.headersSent) {
        res.status(404).json({ message: 'File not found' });
      } else {
        // If headers have been sent, we need to end the response
        res.end();
      }
    });
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ message: 'Failed to download file' });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
