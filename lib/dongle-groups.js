'use strict';

const fs = require('fs');
const path = require('path');

const GROUP_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#a78bfa', '#fb7185', '#22d3ee', '#c084fc', '#84cc16'];
const DEFAULT_FILE = process.env.DONGLE_GROUPS_FILE || '/etc/sokrat/dongle-groups.json';

function slugify(value, fallback = 'group') {
    const slug = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || fallback;
}

function normalizeConfig(raw, options = {}) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const employeeGroups = Array.isArray(options.employeeGroups) ? options.employeeGroups : [];
    const groups = [];
    const usedIds = new Set();
    const assignedDongles = new Set();

    (Array.isArray(source.groups) ? source.groups : []).forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') return;
        const name = String(entry.name || '').trim();
        if (!name) return;
        let id = slugify(entry.id || name, `group-${index + 1}`);
        while (usedIds.has(id)) id = `${id}-${index + 1}`;
        usedIds.add(id);
        const dongles = [...new Set((Array.isArray(entry.dongles) ? entry.dongles : [])
            .map(value => String(value || '').trim())
            .filter(Boolean))]
            .filter(id => {
                if (assignedDongles.has(id)) return false;
                assignedDongles.add(id);
                return true;
            });
        const color = /^#[0-9a-f]{6}$/i.test(String(entry.color || ''))
            ? String(entry.color).toLowerCase()
            : GROUP_COLORS[index % GROUP_COLORS.length];
        groups.push({ id, name, color, dongles });
    });

    if (options.includeEmployeeGroups) {
        employeeGroups.forEach(name => {
            const clean = String(name || '').trim();
            if (!clean) return;
            if (groups.some(group => group.name === clean)) return;
            let id = slugify(clean, `group-${groups.length + 1}`);
            while (usedIds.has(id)) id = `${id}-${groups.length + 1}`;
            usedIds.add(id);
            groups.push({ id, name: clean, color: GROUP_COLORS[groups.length % GROUP_COLORS.length], dongles: [] });
        });
    }

    const dongles = {};
    if (source.dongles && typeof source.dongles === 'object' && !Array.isArray(source.dongles)) {
        Object.entries(source.dongles).forEach(([id, value]) => {
            if (id === '__proto__' || id === 'constructor' || id === 'prototype') return;
            if (value && typeof value === 'object' && !Array.isArray(value)) dongles[id] = value;
        });
    }

    return { version: 1, groups, dongles };
}

function readConfig(filePath = DEFAULT_FILE, options = {}) {
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return normalizeConfig(raw, options);
    } catch (_) {
        return normalizeConfig({}, options);
    }
}

function writeConfig(config, filePath = DEFAULT_FILE, options = {}) {
    const normalized = normalizeConfig(config, options);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o644 });
    fs.renameSync(tempPath, filePath);
    return normalized;
}

module.exports = { DEFAULT_FILE, GROUP_COLORS, slugify, normalizeConfig, readConfig, writeConfig };
