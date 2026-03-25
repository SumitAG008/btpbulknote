const cds = require('@sap/cds')
const nodemailer = require('nodemailer')
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client')

function toDateOnly(d) {
  const x = new Date(d)
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()))
}

function sameMonthDay(a, b) {
  return a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate()
}

function calcYears(fromDate, onDate) {
  const f = toDateOnly(fromDate)
  const o = toDateOnly(onDate)
  let years = o.getUTCFullYear() - f.getUTCFullYear()
  const anniversaryThisYear = new Date(Date.UTC(o.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate()))
  if (o < anniversaryThisYear) years -= 1
  return years
}

function renderTemplate(tpl, ctx) {
  if (!tpl) return ''
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => (ctx[k] ?? ''))
}

async function getEmployees(runDate) {
  if ((process.env.SF_MOCK || '').toLowerCase() === 'true') {
    return [
      {
        employeeId: '1001',
        fullName: 'Demo User',
        email: process.env.MOCK_TO_EMAIL || 'demo@example.com',
        dateOfBirth: '1995-03-10',
        hireDate: '2020-03-10',
        legalEntity: 'DEMO',
        locale: 'en'
      }
    ]
  }

  const destinationName = process.env.SF_DESTINATION
  const destinationPath = process.env.SF_ODATA_PATH || '/User'
  if (destinationName) {
    const query = process.env.SF_ODATA_QUERY || '?$top=50&$format=json'
    const response = await executeHttpRequest(
      { destinationName },
      {
        method: 'GET',
        url: `${destinationPath}${query}`,
        headers: { Accept: 'application/json' }
      }
    )

    const data = response?.data
    const results = data?.d?.results ?? data?.value ?? []

    return results
      .map(r => ({
        employeeId: String(r.personIdExternal ?? r.userId ?? r.employeeId ?? ''),
        fullName: r.defaultFullName ?? r.fullName ?? `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim(),
        email: r.email ?? r.emailAddress ?? r.businessEmail ?? '',
        dateOfBirth: r.dateOfBirth ?? r.birthday ?? null,
        hireDate: r.hireDate ?? r.startDate ?? r.originalStartDate ?? null,
        legalEntity: r.legalEntity ?? r.company ?? null,
        locale: r.locale ?? r.defaultLocale ?? 'en'
      }))
      .filter(e => e.employeeId && e.email)
  }

  const url = process.env.SF_API_URL
  const user = process.env.SF_API_USER
  const pass = process.env.SF_API_PASS
  if (!url || !user || !pass) {
    throw new Error('Missing SuccessFactors configuration: set SF_DESTINATION (recommended) or SF_API_URL, SF_API_USER, SF_API_PASS, or enable SF_MOCK=true')
  }

  const basic = Buffer.from(`${user}:${pass}`).toString('base64')
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: 'application/json'
    }
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`SuccessFactors API error ${res.status}: ${txt}`)
  }

  const data = await res.json()
  const results = data?.d?.results ?? data?.value ?? []

  return results.map(r => ({
    employeeId: String(r.personIdExternal ?? r.userId ?? r.employeeId ?? ''),
    fullName: r.defaultFullName ?? r.fullName ?? `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim(),
    email: r.email ?? r.emailAddress ?? r.businessEmail ?? '',
    dateOfBirth: r.dateOfBirth ?? r.birthday ?? null,
    hireDate: r.hireDate ?? r.startDate ?? r.originalStartDate ?? null,
    legalEntity: r.legalEntity ?? r.company ?? null,
    locale: r.locale ?? r.defaultLocale ?? 'en'
  })).filter(e => e.employeeId && e.email)
}

function buildMailer() {
  const host = process.env.SMTP_HOST
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587
  const secure = (process.env.SMTP_SECURE || '').toLowerCase() === 'true'
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS

  if (!host) throw new Error('Missing SMTP_HOST')

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined
  })
}

module.exports = cds.service.impl(async function () {
  const { NotificationConfigs, NotificationRuns, EmployeeNotificationLogs } = this.entities

  this.on('runDaily', async (req) => {
    const dryRun = !!req.data.dryRun
    const runAt = new Date()
    const runDate = req.data.runDate ? toDateOnly(req.data.runDate) : toDateOnly(runAt)

    const tx = cds.tx(req)
    const run = await tx.run(
      INSERT.into(NotificationRuns).entries({
        runAt,
        runType: 'DAILY',
        totalProcessed: 0,
        totalSent: 0,
        totalFailed: 0
      })
    )

    let totalProcessed = 0
    let totalSent = 0
    let totalFailed = 0

    const configs = await tx.run(SELECT.from(NotificationConfigs).where({ active: true }))
    const byKey = new Map()
    for (const c of configs) {
      const key = `${c.eventType || ''}::${c.locale || ''}::${c.legalEntity || ''}`
      byKey.set(key, c)
    }

    const employees = await getEmployees(runDate)

    const smtpDisabled = (process.env.SMTP_DISABLED || '').toLowerCase() === 'true'
    const mailer = smtpDisabled ? null : buildMailer()

    for (const e of employees) {
      totalProcessed += 1

      const dob = e.dateOfBirth ? toDateOnly(e.dateOfBirth) : null
      const hire = e.hireDate ? toDateOnly(e.hireDate) : null

      const events = []
      if (dob && sameMonthDay(dob, runDate)) {
        events.push({ eventType: 'BIRTHDAY', milestoneYears: null })
      }
      if (hire && sameMonthDay(hire, runDate)) {
        const years = calcYears(hire, runDate)
        events.push({ eventType: 'ANNIVERSARY', milestoneYears: years })
      }

      for (const ev of events) {
        const already = await tx.run(
          SELECT.one.from(EmployeeNotificationLogs).where({
            employeeId: e.employeeId,
            eventType: ev.eventType,
            eventDate: runDate
          })
        )
        if (already) continue

        const key = `${ev.eventType}::${e.locale || ''}::${e.legalEntity || ''}`
        const cfg = byKey.get(key) || byKey.get(`${ev.eventType}::${e.locale || ''}::`) || byKey.get(`${ev.eventType}::::`) || null

        const fromEmail = cfg?.fromEmail || process.env.DEFAULT_FROM_EMAIL || 'no-reply@example.com'
        const subjectTpl = cfg?.subjectTemplate || (ev.eventType === 'BIRTHDAY' ? 'Happy Birthday, {{fullName}}!' : 'Happy Work Anniversary, {{fullName}}!')
        const bodyTpl = cfg?.bodyTemplate || (ev.eventType === 'BIRTHDAY' ? 'Dear {{fullName}},\n\nHappy Birthday!' : 'Dear {{fullName}},\n\nCongratulations on {{milestoneYears}} years!')

        const ctx = {
          employeeId: e.employeeId,
          fullName: e.fullName,
          email: e.email,
          eventType: ev.eventType,
          milestoneYears: ev.milestoneYears ?? ''
        }

        const subject = renderTemplate(subjectTpl, ctx)
        const body = renderTemplate(bodyTpl, ctx)

        try {
          let providerRef = null
          if (!dryRun && !smtpDisabled) {
            const info = await mailer.sendMail({
              from: fromEmail,
              to: e.email,
              subject,
              text: body
            })
            providerRef = info?.messageId || null
          }

          await tx.run(
            INSERT.into(EmployeeNotificationLogs).entries({
              employeeId: e.employeeId,
              email: e.email,
              fullName: e.fullName,
              eventType: ev.eventType,
              milestoneYears: ev.milestoneYears,
              eventDate: runDate,
              sentAt: new Date(),
              status: dryRun ? 'DRY_RUN' : 'SENT',
              errorDetails: null,
              providerRef
            })
          )

          totalSent += 1
        } catch (err) {
          totalFailed += 1
          await tx.run(
            INSERT.into(EmployeeNotificationLogs).entries({
              employeeId: e.employeeId,
              email: e.email,
              fullName: e.fullName,
              eventType: ev.eventType,
              milestoneYears: ev.milestoneYears,
              eventDate: runDate,
              sentAt: new Date(),
              status: 'FAILED',
              errorDetails: String(err && err.message ? err.message : err),
              providerRef: null
            })
          )
        }
      }
    }

    await tx.run(
      UPDATE(NotificationRuns, run.ID).set({
        totalProcessed,
        totalSent,
        totalFailed
      })
    )

    return { ...run, totalProcessed, totalSent, totalFailed }
  })
})
