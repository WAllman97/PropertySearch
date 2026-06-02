#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const argv = require('yargs').argv

const root = process.cwd()
const configPath = path.join(root, 'template-config.json')

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
}

async function main() {
  const config = readJSON(configPath) || {}
  const name = argv.name || config.name || 'my-app'
  const description = argv.description || config.description || ''
  const author = argv.author || config.author || ''

  // update package.json
  const pkgPath = path.join(root, 'package.json')
  const pkg = readJSON(pkgPath) || {}
  pkg.name = name
  if (description) pkg.description = description
  if (author) pkg.author = author
  writeJSON(pkgPath, pkg)

  // update README
  const readmePath = path.join(root, 'README.md')
  if (fs.existsSync(readmePath)) {
    let rd = fs.readFileSync(readmePath, 'utf8')
    rd = rd.replace(/Web App Template/g, name)
    fs.writeFileSync(readmePath, rd)
  }

  console.log(`Renamed template to ${name}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
