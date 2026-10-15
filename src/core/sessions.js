'use strict';
/** מצב כניסה של תלמיד ומנהל – נשמר בתהליך הראשי בלבד, כך שהממשק לא יכול לזייף הרשאות. */
class Sessions {
  constructor(getSettings, now = () => Date.now()) {
    this.getSettings = getSettings;
    this.now = now;
    this.student = null;
    this.admin = null;
  }
  startStudent(info) { this.student = { ...info, counted: false, last: this.now() }; return this.student; }
  startAdmin() { this.admin = { last: this.now() }; return this.admin; }
  endAll() { this.student = null; this.admin = null; }

  touchStudent() {
    const s = this.student;
    if (!s) return null;
    if (this.now() - s.last > this.getSettings().studentIdleSeconds * 1000) { this.student = null; return null; }
    s.last = this.now();
    return s;
  }
  touchAdmin() {
    const a = this.admin;
    if (!a) return null;
    if (this.now() - a.last > this.getSettings().adminIdleSeconds * 1000) { this.admin = null; return null; }
    a.last = this.now();
    return a;
  }
  sweep() {
    const ended = [];
    const st = this.getSettings();
    if (this.student && this.now() - this.student.last > st.studentIdleSeconds * 1000) { this.student = null; ended.push('student'); }
    if (this.admin && this.now() - this.admin.last > st.adminIdleSeconds * 1000) { this.admin = null; ended.push('admin'); }
    return ended;
  }
}
module.exports = { Sessions };
