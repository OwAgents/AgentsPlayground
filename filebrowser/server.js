const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Root directory for file browsing. Defaults to the filesystem root so the
// browser has full access to the system; set STORAGE_DIR to serve a subtree.
const ROOT_DIR = path.resolve(process.env.STORAGE_DIR || '/');

// Default directory the Explorer lands in when opened. Defaults to the
// current user's home directory (e.g. /root on workers). Set START_DIR to
// override. Kept relative to ROOT_DIR so crumbs/navigation stay consistent.
const START_PATH = path.relative(ROOT_DIR, path.resolve(process.env.START_DIR || os.homedir()));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const targetDir = req.query.dir ? path.resolve(ROOT_DIR, req.query.dir) : ROOT_DIR;
    if (!targetDir.startsWith(ROOT_DIR)) {
      return cb(new Error('Access denied'), null);
    }
    fs.mkdirSync(targetDir, { recursive: true });
    cb(null, targetDir);
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  }
});
const upload = multer({ storage });

function safePath(reqPath) {
  const target = path.resolve(ROOT_DIR, reqPath || '');
  if (!target.startsWith(ROOT_DIR)) {
    return ROOT_DIR;
  }
  return target;
}

function getFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico'];
  const audioExts = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];
  const videoExts = ['.mp4', '.webm', '.ogg', '.mov', '.mkv'];
  const textExts = ['.txt', '.js', '.json', '.html', '.htm', '.css', '.scss', '.md', '.py', '.sh', '.ts', '.jsx', '.tsx', '.c', '.cpp', '.h', '.java', '.yaml', '.yml', '.xml', '.sql', '.csv', '.log', '.env', '.toml', '.ini', '.conf', '.bat', '.cmd', '.ps1'];

  if (imageExts.includes(ext)) return 'image';
  if (audioExts.includes(ext)) return 'audio';
  if (videoExts.includes(ext)) return 'video';
  if (textExts.includes(ext)) return 'text';
  return 'other';
}

function decodeRouteSegment(value) {
  try {
    return decodeURIComponent(value || '');
  } catch {
    return value || '';
  }
}

function sendExplorer(res) {
  res.sendFile(path.join(__dirname, 'public/explorer/index.html'));
}

// API: List contents of directory
app.get('/api/files', async (req, res) => {
  try {
    const relPath = req.query.path || '';
    const fullPath = safePath(relPath);
    
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    const stat = await fs.promises.stat(fullPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    const items = await fs.promises.readdir(fullPath, { withFileTypes: true });
    const result = await Promise.all(items.map(async (item) => {
      const itemPath = path.join(fullPath, item.name);
      let size = 0;
      let mtime = null;
      let isDir = item.isDirectory();
      try {
        const itemStat = await fs.promises.stat(itemPath);
        isDir = itemStat.isDirectory();
        size = itemStat.size;
        mtime = itemStat.mtime;
      } catch (e) {}

      return {
        name: item.name,
        isDir: isDir,
        size: size,
        mtime: mtime,
        type: isDir ? 'directory' : getFileType(item.name),
        ext: path.extname(item.name).toLowerCase()
      };
    }));

    result.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    res.json({
      currentPath: path.relative(ROOT_DIR, fullPath),
      parentPath: fullPath === ROOT_DIR ? null : path.relative(ROOT_DIR, path.dirname(fullPath)),
      items: result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Read raw file content (for text/editing)
app.get('/api/read', async (req, res) => {
  try {
    const fullPath = safePath(req.query.path);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    const content = await fs.promises.readFile(fullPath, 'utf8');
    res.json({ content, path: path.relative(ROOT_DIR, fullPath) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Raw stream file for audio/video/image preview download
app.get('/api/raw', (req, res) => {
  const fullPath = safePath(req.query.path);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).send('File not found');
  }
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(fullPath, { dotfiles: 'allow' });
});

// API: Save file content
app.post('/api/save', async (req, res) => {
  try {
    const { path: reqPath, content } = req.body;
    const fullPath = safePath(reqPath);
    await fs.promises.writeFile(fullPath, content, 'utf8');
    res.json({ success: true, path: path.relative(ROOT_DIR, fullPath) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Create new file or folder
app.post('/api/create', async (req, res) => {
  try {
    const { path: reqPath, name, isDir } = req.body;
    const targetDir = safePath(reqPath);
    const fullPath = path.join(targetDir, name);

    if (!fullPath.startsWith(ROOT_DIR)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (fs.existsSync(fullPath)) {
      return res.status(400).json({ error: 'Item already exists' });
    }

    if (isDir) {
      await fs.promises.mkdir(fullPath, { recursive: true });
    } else {
      await fs.promises.writeFile(fullPath, '', 'utf8');
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Delete file or directory
app.post('/api/delete', async (req, res) => {
  try {
    const { path: reqPath } = req.body;
    const fullPath = safePath(reqPath);

    if (fullPath === ROOT_DIR) {
      return res.status(400).json({ error: 'Cannot delete root directory' });
    }

    await fs.promises.rm(fullPath, { recursive: true, force: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Upload files
app.post('/api/upload', upload.array('files'), (req, res) => {
  res.json({ success: true, count: req.files ? req.files.length : 0 });
});

// API: Default path for a fresh Explorer load.
app.get('/api/start', (req, res) => {
  res.json({ path: START_PATH });
});

app.get(['/', '/explorer', '/browse'], (req, res) => sendExplorer(res));

// Directory routes render Explorer; file routes stream the raw file for viewing.
app.get('/browse/*', (req, res) => {
  const relPath = decodeRouteSegment(req.params[0]);
  const fullPath = safePath(relPath);
  try {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) return sendExplorer(res);
    if (stat.isFile()) {
      return res.sendFile(fullPath, { dotfiles: 'allow' }, (error) => {
        if (!error) return;
        if (!res.headersSent) res.status(404).json({ error: 'File not found' });
      });
    }
    return res.status(404).json({ error: 'Not found' });
  } catch {
    return res.status(404).json({ error: 'File not found' });
  }
});

app.get('/edit', (req, res) => {
  res.status(400).json({ error: 'Edit route requires a file path' });
});

// Edit routes render Explorer with the editor opened for the target text file.
app.get('/edit/*', (req, res) => {
  const relPath = decodeRouteSegment(req.params[0]);
  const fullPath = safePath(relPath);
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) return res.status(400).json({ error: 'Expected file path' });
    if (getFileType(fullPath) !== 'text') return res.status(415).json({ error: 'Only text files are editable' });
    return sendExplorer(res);
  } catch {
    return res.status(404).json({ error: 'File not found' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Serving filesystem root: ${ROOT_DIR}`);
  console.log(`Default start directory: ${START_PATH || ROOT_DIR}`);
  console.log(`File Explorer: http://localhost:${PORT}/`);
  console.log(`Browse directory: http://localhost:${PORT}/browse/<path>`);
  console.log(`Edit text file: http://localhost:${PORT}/edit/<path>`);
});
