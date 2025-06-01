// src/db/db.js

const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, 'db.json');

// Make sure db.json is always an array
if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, JSON.stringify([], null, 2));
}

function readDB() {
  if (!fs.existsSync(DB_PATH)) return [];
  const data = JSON.parse(fs.readFileSync(DB_PATH));
  return Array.isArray(data) ? data : [];
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function getUser(telegram_id) {
  const db = readDB();
  return db.find(u => u.user[0] === telegram_id);
}

function getProject(telegram_id, ca) {
  const user = getUser(telegram_id);
  if (!user) return null;
  return user.projects.find(p => p.ca === ca) || null;
}

// Add or update a project for a user
function addOrUpdateProject(telegram_id, username, ca, token_name, projectData) {
  let db = readDB();
  let userIdx = db.findIndex(u => u.user[0] === telegram_id);

  if (userIdx === -1) {
    // New user
    db.push({
      user: [telegram_id, username],
      projects: [{
        ca,
        token_name,
        ...projectData
      }]
    });
  } else {
    // Existing user
    let user = db[userIdx];
    let projectIdx = user.projects.findIndex(p => p.ca === ca);
    if (projectIdx === -1) {
      // New project
      user.projects.push({
        ca,
        token_name,
        ...projectData
      });
    } else {
      // Update project
      user.projects[projectIdx] = {
        ...user.projects[projectIdx],
        ...projectData
      };
    }
    db[userIdx] = user;
  }
  writeDB(db);
}

module.exports = {
  readDB,
  writeDB,
  getUser,
  getProject,
  addOrUpdateProject,
};
