/* =========================================================================
 * engine.js — 人生财务寿命与缺口分析 · 测算引擎（v3，合并版问卷）
 * -------------------------------------------------------------------------
 * 纯函数、零依赖，可在浏览器(挂到 window.FPEngine)与 Node(module.exports)双用。
 *
 * 核心模型（逐年现金流递推，单位：万元人民币）：
 *   期末 = 期初 + 收益(=期初×年化) + 主动收入 + 被动收益(投资项) − 支出
 *   期初(次年) = 上年期末
 *   支出 = 住房(租/买/还贷中/自有) + 基本生活 + 投资投入(投资项) + 生育规划(可选)
 *
 * 「投资和被动收入」统一为 items[]：每一项同时含「投入段」与「收益段」，
 *   覆盖原 社保养老金 / 商业保险年金 / 大额投资支出 三类需求。
 *
 * 对外方法：
 *   buildPlan(answers)  → 把问卷答案映射为可计算的 plan 配置
 *   project(plan)       → 跑逐年轨迹，返回 {rows, metrics}
 *   compare(plan)       → 同一计划下的「乐观 / 悲观」压力测试，给出终点增量
 *   formatWan(n)        → 数字格式化
 *   monthlyMortgage(P, annualRate, years) → 等额本息月供
 *   annualMortgage(...) → 等额本息年供
 *   ageFromDob(dob, ref)→ 由出生日期算周岁
 * ========================================================================= */
(function (global) {
  'use strict';

  // ---- 默认贷款利率（2026 年首套参考值，UI 可覆盖）----------------------
  const DEFAULT_COMM_RATE = 0.031;   // 商业贷款年利率（首套，约 3.1%）
  const DEFAULT_GJJ_RATE  = 0.0285;  // 公积金贷款年利率（5 年以上，约 2.85%）
  const RENT_GROWTH       = 0.02;    // 一直租房 / 购房前租房：每年房租固定涨幅 2%
  const LIVING_GROWTH     = 0.02;    // 基本生活开支：每年固定涨幅 2%

  // 分年龄段养育支出参考（child age = 当前年 − 出生年；monthly 单位：万/月）
  // 阶段覆盖：孕产（含备孕/出生当年）→ 幼儿 → 幼儿园 → 小学 → 初中 → 高中 → 大学
  const DEFAULT_CHILD_STAGES = [
    { from: -1, to: 0,  annual: 4.8 }, // 孕产阶段（备孕 + 出生当年）
    { from: 1,  to: 3,  annual: 3.6 }, // 幼儿阶段
    { from: 4,  to: 6,  annual: 3.0 }, // 幼儿园阶段
    { from: 7,  to: 12, annual: 2.4 }, // 小学阶段
    { from: 13, to: 15, annual: 3.0 }, // 初中阶段
    { from: 16, to: 18, annual: 3.6 }, // 高中阶段
    { from: 19, to: 22, annual: 4.8 }, // 大学阶段
  ];

  // 父母赡养支出参考（parent age = 当前年 − 父母出生年；annual 单位：万/年，每位父母）
  // 分 4 段：当前年龄–59 / 60–69 / 70–79 / 80 岁以上（越往后照护与医疗支出越高）
  const DEFAULT_PARENT_STAGES = [
    { from: 0,  to: 59, annual: 1.0 },  // 未退休 / 刚退休：日常孝敬为主
    { from: 60, to: 69, annual: 2.0 },  // 退休初期：体检、慢病用药、生活补贴
    { from: 70, to: 79, annual: 4.0 },  // 高龄：医疗自费部分上升、可能需要陪护
    { from: 80, to: 200, annual: 8.0 }, // 80+：长期护理 / 失能照护的高发区间
  ];
  const DEFAULT_PARENT_STOP_AGE = 90;   // 赡养测算默认到父母 90 岁为止（与全局测算终点 90 岁一致）

  // 等额本息月供（万元）
  function monthlyMortgage(P, annualRate, years) {
    if (P <= 0 || years <= 0) return 0;
    const r = annualRate / 12;
    const n = years * 12;
    const f = Math.pow(1 + r, n);
    return (P * r * f) / (f - 1);
  }
  // 等额本息年供（万元）
  function annualMortgage(P, annualRate, years) {
    return monthlyMortgage(P, annualRate, years) * 12;
  }

  // 等额本息月供时间表（含提前还贷）：返回 {yrSince: 月供(万)}，yrSince 从 1 起。
  // prepays: [{yearSince(1..termYears), amount(万), reduceTerm(布尔)}]，在对应年份「年初」冲抵本金：
  //   reduceTerm=false（保持还款年限）→ 之后按「剩余本金 / 剩余期限」重算月供，月供减少、到期日不变；
  //   reduceTerm=true （减少还款年限）→ 月供保持不变，按原月供继续摊还，贷款提前结清。
  function loanSchedule(principal, annualRate, termYears, prepays) {
    const sched = {};
    if (!(principal > 0) || !(termYears > 0)) return sched;
    const r = annualRate / 12;
    const totalMonths = termYears * 12;
    let bal = principal;
    const byYear = {}; // yearSince -> {amount, reduceTerm}
    (prepays || []).forEach(p => {
      const ys = p.yearSince;
      if (ys >= 1 && ys <= termYears) {
        if (!byYear[ys]) byYear[ys] = { amount: 0, reduceTerm: false };
        byYear[ys].amount += (p.amount > 0 ? p.amount : 0);
        if (p.reduceTerm) byYear[ys].reduceTerm = true;
      }
    });
    // 初始月供（等额本息）
    let curM = (r > 0)
      ? bal * r * Math.pow(1 + r, totalMonths) / (Math.pow(1 + r, totalMonths) - 1)
      : bal / totalMonths;
    let yrSince = 1, mInYear = 0, yearSum = 0;
    for (let m = 1; m <= totalMonths; m++) {
      if (mInYear === 0 && byYear[yrSince]) {           // 年初冲抵本金
        bal = Math.max(0, bal - byYear[yrSince].amount);
        if (bal <= 0) { sched[yrSince] = 0; break; }    // 已还清
        const left = totalMonths - (m - 1);             // 含本月剩余月数
        if (byYear[yrSince].reduceTerm) {
          // 减少还款年限：月供保持不变，按原 curM 继续摊还，贷款提前结清
        } else {
          // 保持还款年限：剩余期限不变，月供减少
          if (r > 0) { const f = Math.pow(1 + r, left); curM = bal * r * f / (f - 1); }
          else curM = bal / left;
        }
      }
      let M = 0;
      if (bal > 0) {
        const interest = bal * r;
        let principalPaid = curM - interest;
        if (principalPaid >= bal) { M = bal + interest; bal = 0; } // 末期（含当月还清）
        else { M = curM; bal -= principalPaid; }
        if (bal < 1e-9) bal = 0;
      }
      yearSum += M;
      mInYear++;
      if (mInYear === 12) { sched[yrSince] = +(yearSum / 12).toFixed(4); yrSince++; mInYear = 0; yearSum = 0; }
      if (bal <= 0) { if (mInYear > 0) sched[yrSince] = +(yearSum / mInYear).toFixed(4); break; } // 年内还清：记录实际月均
    }
    return sched;
  }

  // 由出生年月日算周岁
  function ageFromDob(dob, ref) {
    ref = ref || new Date();
    const d = new Date(dob);
    if (isNaN(d.getTime())) return null;
    let age = ref.getFullYear() - d.getFullYear();
    const m = ref.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && ref.getDate() < d.getDate())) age--;
    return age;
  }

  /**
   * 把问卷答案映射为内部 plan 配置。
   * 关键输入字段（数值类型由 UI 直接传 number）：
   *   dob(字符串) / currentAge(数字)
   *   startBalance(万)        当前可投资资产
   *   incomeType / wageBands([{from,to,annual}] 按年龄段、万/年、税后) 收入状况
   *   retireAge / targetAge / returnRate
   *   items:[{name, customName, investStartYear, investYears, investAmount(万/年),
   *          payoutType('monthly'|'yearly'|'onetime'), payoutAmount(万),
   *          payoutStartOffset(年数), payoutYears(年数)}]
   *        —— 每项同时含投入段(investStartYear 起 investYears 年, investAmount 万/年)
   *           与收益段(投资开始 + payoutStartOffset 年起, 持续 payoutYears 年,
   *           按月×12 / 按年 / 一次性 计入被动收益)。覆盖了原 社保养老金 / 商业保险年金 / 投资支出。
   *   housing: 'own'|'ownLoan'|'rent'|'buy'
   *     ownLoan → ownLoanCommBal(商贷余额,万) + ownLoanCommRate(商贷利率,小数)
   *                + ownLoanGjjBal(公积金余额,万) + ownLoanGjjRate(公积金利率,小数)
   *                + loanEndYear(还贷结束年份)；兼容性保留 ownLoanMonthly + ownLoanRate(合并兜底)
   *     rent    → rentMonthly(万/月)，年增 RENT_GROWTH
   *     buy     → buyTotal, downPayment, loanGjj, loanComm, loanYears, gjjRate, commRate,
   *               buyYear(购房年份), preBuyRentMonthly(购房前租金,万/月)
   *   dailyAnnual(万/年，总数) + livingGrowth(默认 2%)：基本生活每年递增
   *   children:{plan('yes'|'no'|'unsure'), count, startYear, annualCost(万/年/孩),
   *            years(抚养年数), incomeLoss(万,一次性)}
   *   lumps:[{year(绝对年份), amount(万), cat}]（可多笔一次性大额进账）
   *   兼容旧字段 lumpSum(万) / lumpYear(绝对年份)
   *   parents:[{label, birthYear, stopAge(赡养截止的父母年龄，默认 90),
   *             stages:[{from,to,annual}]}]（父母赡养支出，按父母年龄分段落段，多位父母累加）
   *   兼容旧字段 parentAnnual(万/年) + parentYears(赡养年数)
   */
  function buildPlan(a) {
    a = a || {};
    const startYear = a.startYear || new Date().getFullYear();
    let currentAge = (typeof a.currentAge === 'number') ? a.currentAge
      : (a.dob ? ageFromDob(a.dob) : 37);
    if (!(currentAge >= 0)) currentAge = 37;
    const retireAge = (typeof a.retireAge === 'number') ? a.retireAge : 60;
    const targetAge = (typeof a.targetAge === 'number') ? a.targetAge : 90;
    const returnRate = (typeof a.returnRate === 'number') ? a.returnRate : 0.02;

    // 收入：按年龄段填写的税后工资（兼容旧单一 wage 字段）
    const incomeType = a.incomeType || 'none'; // stable | freelance | uncertain | none
    let wageBands = [];
    if (Array.isArray(a.wageBands) && a.wageBands.length) {
      wageBands = a.wageBands
        .filter(b => b && typeof b.annual === 'number')
        .map(b => ({ from: (typeof b.from === 'number' ? b.from : 0), to: (typeof b.to === 'number' ? b.to : (b.from || 0)), annual: b.annual }));
    }
    if (!wageBands.length && (typeof a.wage === 'number') && a.wage > 0) {
      wageBands = [{ from: 0, to: 120, annual: a.wage }]; // 旧字段兜底：全年段同一工资
    }

    // 投资和被动收入（统一项：投入段 + 收益段）
    const items = Array.isArray(a.items)
      ? a.items.filter(e => e && (e.investAmount > 0 || e.payoutAmount > 0)).map(e => ({
          name: e.name || '其它',
          customName: e.customName || '',
          investStartYear: (typeof e.investStartYear === 'number') ? e.investStartYear : startYear,
          investYears: (typeof e.investYears === 'number' && e.investYears > 0) ? e.investYears : 0,
          investAmount: (typeof e.investAmount === 'number') ? e.investAmount : 0, // 万/年
          payoutType: 'yearly', // 收益方式已移除，统一按「万/年」计入
          payoutAmount: (typeof e.payoutAmount === 'number') ? e.payoutAmount : 0, // 万/年
          payoutStartYear: (typeof e.payoutStartYear === 'number') ? e.payoutStartYear
            : (typeof e.payoutStartOffset === 'number' ? (e.investStartYear || startYear) + e.payoutStartOffset : startYear + 30), // 绝对年份
          payoutYears: (typeof e.payoutYears === 'number' && e.payoutYears > 0) ? e.payoutYears : 1,
        }))
      : [];

    // 住房
    const housing = a.housing || 'rent'; // own | ownLoan | rent | buy
    // 已有房（还贷中）拆分为商贷 + 公积金：各自余额 + 利率，共享还贷结束年份
    const ownLoanCommBal = (typeof a.ownLoanCommBal === 'number') ? a.ownLoanCommBal : 0; // 商贷余额（万）
    const ownLoanCommRate = (typeof a.ownLoanCommRate === 'number') ? a.ownLoanCommRate : DEFAULT_COMM_RATE; // 小数
    const ownLoanGjjBal = (typeof a.ownLoanGjjBal === 'number') ? a.ownLoanGjjBal : 0; // 公积金余额（万）
    const ownLoanGjjRate = (typeof a.ownLoanGjjRate === 'number') ? a.ownLoanGjjRate : DEFAULT_GJJ_RATE; // 小数
    const ownLoanMonthly = (typeof a.ownLoanMonthly === 'number') ? a.ownLoanMonthly : 0; // 旧字段兜底（合并月供）
    const ownLoanRate = (typeof a.ownLoanRate === 'number') ? a.ownLoanRate : DEFAULT_COMM_RATE; // 旧字段兜底利率
    const rentMonthly = (typeof a.rentMonthly === 'number') ? a.rentMonthly : 0;           // 万/月
    const preBuyRentMonthly = (typeof a.preBuyRentMonthly === 'number') ? a.preBuyRentMonthly : 0; // 万/月（计划购房前）
    const buyTotal = (typeof a.buyTotal === 'number') ? a.buyTotal : 0;       // 计划购房总额
    const downPayment = (typeof a.downPayment === 'number') ? a.downPayment : 0; // 首付
    const loanGjj = (typeof a.loanGjj === 'number') ? a.loanGjj : 0;           // 公积金贷
    const loanComm = (typeof a.loanComm === 'number') ? a.loanComm : 0;        // 商贷
    const loanYears = (typeof a.loanYears === 'number') ? a.loanYears : 30;
    const gjjRate = (typeof a.gjjRate === 'number') ? a.gjjRate : DEFAULT_GJJ_RATE;
    const commRate = (typeof a.commRate === 'number') ? a.commRate : DEFAULT_COMM_RATE;
    const buyYear = (typeof a.buyYear === 'number') ? a.buyYear : startYear; // 计划购房年份（默认今年）
    const loanEndYear = (typeof a.loanEndYear === 'number') ? a.loanEndYear : (startYear + loanYears); // 已有房还贷中：还贷结束年份
    const ownRemTerm = Math.max(0, (loanEndYear - startYear) + 1); // 已有房：剩余还贷年数（含首尾，从模拟起点算）
    // 提前还贷：prepays=[{year(绝对), which('gjj'|'comm'|'loan'), amount(万), mode('keepTerm'|'reduceTerm')}]
    //   mode='keepTerm'（保持还款年限，月供减少，默认） / 'reduceTerm'（减少还款年限，月供不变、提前结清）
    //   buy / ownLoan 均可指定 gjj 或 comm；which='loan' 仅用于旧字段兜底（合并房贷）
    const prepaysRaw = (Array.isArray(a.prepays) ? a.prepays : []).filter(p => p && (typeof p.amount === 'number' ? p.amount : 0) > 0 && (typeof p.year === 'number') && (p.which === 'gjj' || p.which === 'comm' || p.which === 'loan'));
    const gjjPrep = [], commPrep = [], ownCommPrep = [], ownGjjPrep = [], ownPrep = [];
    prepaysRaw.forEach(p => {
      const rt = (p.mode === 'reduceTerm') || (p.reduceTerm === true); // true=减少还款年限(月供不变)；false=保持年限(月供减少)
      if (p.which === 'gjj' || p.which === 'comm') {
        const ysB = p.year - buyYear;
        if (ysB >= 1 && ysB <= loanYears) (p.which === 'gjj' ? gjjPrep : commPrep).push({ yearSince: ysB, amount: p.amount, reduceTerm: rt });
        const ysO = (p.year - startYear) + 1;
        if (ysO >= 1 && ysO <= ownRemTerm) (p.which === 'gjj' ? ownGjjPrep : ownCommPrep).push({ yearSince: ysO, amount: p.amount, reduceTerm: rt });
      } else if (p.which === 'loan') {
        const ysO = (p.year - startYear) + 1;
        if (ysO >= 1 && ysO <= ownRemTerm) ownPrep.push({ yearSince: ysO, amount: p.amount, reduceTerm: rt });
      }
    });
    // 已有房（还贷中）月供时间表
    let ownCommMonthlyByYear = {}, ownGjjMonthlyByYear = {}, ownMonthlyByYear = {};
    let ownLoanMonthlyTotal = 0, ownCommMonthly = 0, ownGjjMonthly = 0; // 首年月供（万/月）
    if ((ownLoanCommBal > 0 || ownLoanGjjBal > 0) && ownRemTerm > 0) {
      // 新模型：余额 + 利率，商贷 / 公积金分别等额本息，逐月时间表相加（含提前还贷）
      ownCommMonthlyByYear = loanSchedule(ownLoanCommBal, ownLoanCommRate, ownRemTerm, ownCommPrep);
      ownGjjMonthlyByYear = loanSchedule(ownLoanGjjBal, ownLoanGjjRate, ownRemTerm, ownGjjPrep);
      ownCommMonthly = monthlyMortgage(ownLoanCommBal, ownLoanCommRate, ownRemTerm);
      ownGjjMonthly = monthlyMortgage(ownLoanGjjBal, ownLoanGjjRate, ownRemTerm);
      ownLoanMonthlyTotal = +(ownCommMonthly + ownGjjMonthly).toFixed(4);
      for (let ys = 1; ys <= ownRemTerm; ys++) ownMonthlyByYear[ys] = (ownCommMonthlyByYear[ys] || 0) + (ownGjjMonthlyByYear[ys] || 0);
    } else if (ownLoanMonthly > 0 && ownRemTerm > 0) {
      // 旧字段兜底：合并月供反推本金（which='loan' 提前还）
      const mRate = ownLoanRate / 12;
      let bal;
      if (mRate > 0) { const f = Math.pow(1 + mRate, ownRemTerm * 12); bal = ownLoanMonthly * (f - 1) / (mRate * f); }
      else bal = ownLoanMonthly * ownRemTerm * 12;
      ownMonthlyByYear = loanSchedule(bal, ownLoanRate, ownRemTerm, ownPrep);
      ownLoanMonthlyTotal = +ownLoanMonthly.toFixed(4);
      ownCommMonthly = ownLoanMonthlyTotal; // 兜底：合并，无法拆分
    }

    // 基本生活（总数，万/年；每年按 livingGrowth 递增）
    const dailyAnnual = (typeof a.dailyAnnual === 'number') ? a.dailyAnnual : 0;
    const livingGrowth = (typeof a.livingGrowth === 'number') ? a.livingGrowth : LIVING_GROWTH;

    // 生育规划
    const childrenPlan = a.childrenPlan || 'no';
    const childCount = (childrenPlan === 'no') ? 0 : (typeof a.childCount === 'number' ? a.childCount : 0);
    const childStartYear = (typeof a.childStartYear === 'number') ? a.childStartYear : startYear;
    const childAnnual = (typeof a.childAnnual === 'number') ? a.childAnnual : 0;       // 万/年/孩
    const childYears = (typeof a.childYears === 'number' && a.childYears > 0) ? a.childYears : 0;
    const childIncomeLoss = (typeof a.childIncomeLoss === 'number') ? a.childIncomeLoss : 0; // 万，一次性（生育当年）
    const childKids = (Array.isArray(a.kids)) ? a.kids.filter(k => k && typeof k.startYear === 'number') : null; // 生娃：逐个孩子的 {startYear, years(可选抚养上限)}
    const childStages = (Array.isArray(a.childStages) && a.childStages.length) ? a.childStages : DEFAULT_CHILD_STAGES; // 分年龄段养育支出（万/月）

    // 一次性大额进账（可多笔）：lumps=[{year, amount(万), cat}]
    let lumps = (Array.isArray(a.lumps)) ? a.lumps
        .filter(l => l && (typeof l.amount === 'number' ? l.amount : 0) > 0 && (typeof l.year === 'number'))
        .map(l => ({ year: l.year, amount: (typeof l.amount === 'number' ? l.amount : 0), cat: l.cat || '' })) : null;
    // 兼容旧的单笔字段 lumpSum / lumpYear
    if (!lumps && (typeof a.lumpSum === 'number' ? a.lumpSum : 0) > 0) {
      lumps = [{ year: (typeof a.lumpYear === 'number' ? a.lumpYear : startYear), amount: a.lumpSum, cat: a.lumpCat || '' }];
    }

    // 父母赡养：每位父母单独一行，按「父母年龄」分段计算，算到 stopAge（默认 90 岁）为止
    // parents=[{label, birthYear, stopAge, stages:[{from,to,annual(万/年)}]}]
    const defaultParentStages = (Array.isArray(a.parentStages) && a.parentStages.length)
      ? a.parentStages : DEFAULT_PARENT_STAGES;
    const parents = (Array.isArray(a.parents)) ? a.parents
      .filter(pt => pt && typeof pt.birthYear === 'number')
      .map(pt => ({
        label: pt.label || '父母',
        birthYear: pt.birthYear,
        stopAge: (typeof pt.stopAge === 'number' && pt.stopAge > 0) ? pt.stopAge : DEFAULT_PARENT_STOP_AGE,
        stages: (Array.isArray(pt.stages) && pt.stages.length) ? pt.stages : defaultParentStages,
      })) : [];

    const startBalance = (typeof a.startBalance === 'number') ? a.startBalance : 100;

    // 购房月供（公积金 + 商贷 各自等额本息；含提前还贷后按月供时间表计）
    const monthlyPayment = +(monthlyMortgage(loanGjj, gjjRate, loanYears)
                          + monthlyMortgage(loanComm, commRate, loanYears)).toFixed(4); // 原始月供（未提前还）
    const gjjMonthly = loanSchedule(loanGjj, gjjRate, loanYears, gjjPrep); // {yrSince: 月供(万)}
    const commMonthly = loanSchedule(loanComm, commRate, loanYears, commPrep);

    return {
      startYear, currentAge, retireAge, targetAge, returnRate, startBalance,
      incomeType, wageBands,
      items,
      housing, ownLoanMonthly: ownLoanMonthlyTotal, ownLoanCommBal, ownLoanGjjBal, ownLoanCommRate, ownLoanGjjRate, ownCommMonthly, ownGjjMonthly, ownCommMonthlyByYear, ownGjjMonthlyByYear, ownMonthlyByYear, rentMonthly, rentGrowth: RENT_GROWTH, preBuyRentMonthly,
      buyTotal, downPayment, loanGjj, loanComm, loanYears, gjjRate, commRate, buyYear, loanEndYear, monthlyPayment,
      gjjMonthly, commMonthly, prepays: prepaysRaw,
      dailyAnnual, livingGrowth,
      children: { plan: childrenPlan, count: childCount, startYear: childStartYear, annualCost: childAnnual, years: childYears, incomeLoss: childIncomeLoss, kids: childKids, stages: childStages },
      lumps,
      parents, parentStages: defaultParentStages,
    };
  }

  // 某年某投资项的现金流：out=本期投入（万/年，现金流出）；inc=本期被动收益（万）
  // 收益开始年 = 投资开始年 + 收益开始年数；按月收入×12。
  function itemFlow(p, year) {
    let out = 0, inc = 0;
    p.items.forEach(it => {
      if (year >= it.investStartYear && year < it.investStartYear + it.investYears) out += it.investAmount;
      const payStart = it.payoutStartYear;
      if (it.payoutType === 'onetime') {
        if (year === payStart) inc += it.payoutAmount;
      } else {
        if (year >= payStart && year < payStart + it.payoutYears) {
          inc += (it.payoutType === 'monthly') ? it.payoutAmount * 12 : it.payoutAmount;
        }
      }
    });
    return { out, inc };
  }

  // 某年生育支出（分年龄段，按 万/年 计入；含每个娃出生当年一次性收入中断损失）
  // 每个孩子可携带自己的 stages（已出生娃仅含「当前岁数起」的阶段；计划生娃含孕产→大学全段）。
  function childExpense(p, year) {
    const c = p.children;
    if (!c) return 0;
    const defaultStages = c.stages && c.stages.length ? c.stages : DEFAULT_CHILD_STAGES;
    // 单个孩子在该年的养育支出：age = 当前年 − 出生年；超 capYears 或不在任何阶段内则为 0
    const kidCost = (k) => {
      const sArr = (k.stages && k.stages.length) ? k.stages : defaultStages;
      const age = year - k.startYear;
      if (k.years && k.years > 0 && age >= k.years) return 0;
      const s = sArr.find(s => age >= s.from && age <= s.to);
      return s ? s.annual : 0; // 万/年，直接计入该年支出
    };
    let e = 0;
    // 多娃：按每个孩子分别计算并累加（收入中断损失在每个娃出生当年计入；已出生娃的出生年已过，自然不再计入）
    if (c.kids && c.kids.length) {
      c.kids.forEach(k => { e += kidCost(k); if (year === k.startYear) e += c.incomeLoss; });
      return e;
    }
    if (c.count <= 0) return 0;
    // 计划生娃（按 count 同生于 startYear，无逐娃 stages 时回退默认阶段表）
    e += c.count * kidCost({ startYear: c.startYear, years: 0, stages: defaultStages });
    if (year === c.startYear) e += c.incomeLoss;
    return e;
  }

  // 某年父母赡养支出（万/年）：逐位父母按「父母年龄」落段，超过 stopAge 停止，多位累加
  // 兼容旧字段：parentAnnual(万/年) + parentYears(赡养年数，自 startYear 起)
  function parentExpense(p, year) {
    let e = 0;
    if (p.parents && p.parents.length) {
      p.parents.forEach(pt => {
        const age = year - pt.birthYear;
        if (age < 0 || age >= pt.stopAge) return; // 尚未出生 / 已过赡养截止年龄
        const s = pt.stages.find(s => age >= s.from && age <= s.to);
        if (s) e += s.annual;
      });
      return e;
    }
    if (typeof p.parentAnnual === 'number' && p.parentAnnual > 0) { // 旧字段兜底
      const y = year - p.startYear;
      if (y >= 0 && y < (typeof p.parentYears === 'number' ? p.parentYears : 0)) e = p.parentAnnual;
    }
    return e;
  }

  // 某年的各项现金流（万元）
  function yearFlows(p, year, age) {
    // 主动收入：按所处年龄段取对应税后工资
    let wage = 0;
    if ((p.incomeType === 'stable' || p.incomeType === 'freelance') && age < p.retireAge) {
      const b = p.wageBands.find(b => age >= b.from && age < b.to);
      if (b) wage = b.annual;
    }

    // 投资项：被动收益（inc）+ 投资投入（out）
    const it = itemFlow(p, year);
    const annuity = it.inc;                 // 被动收益合计（社保/年金/其它）
    let oneTime = 0;
    if (p.lumps && p.lumps.length) oneTime = p.lumps.filter(l => l.year === year).reduce((s, l) => s + l.amount, 0);
    else if (year === p.lumpYear) oneTime = p.lumpSum; // 旧字段兜底

    // 住房
    let housing = 0;
    if (p.housing === 'own') {
      housing = 0;
    } else if (p.housing === 'ownLoan') {
      const ys = (year - p.startYear) + 1; // 1=模拟起点年；含提前还贷后月供时间表
      housing = (p.ownMonthlyByYear[ys] || 0) * 12;
    } else if (p.housing === 'rent') {
      housing = p.rentMonthly * 12 * Math.pow(1 + p.rentGrowth, year - p.startYear); // 租房，年增 2%
    } else { // buy 计划购房
      const yrSince = year - p.buyYear;
      if (yrSince < 0) housing = p.preBuyRentMonthly * 12 * Math.pow(1 + p.rentGrowth, year - p.startYear); // 购房前租金
      else if (yrSince === 0) housing = p.downPayment;            // 购房当年付首付
      else if (yrSince <= p.loanYears) housing = ((p.gjjMonthly[yrSince] || 0) + (p.commMonthly[yrSince] || 0)) * 12; // 还贷期（含提前还贷后月供）
      else housing = 0;                                       // 还清后无住房支出
    }

    // 基本生活（每年按 livingGrowth 递增）
    const daily = p.dailyAnnual * Math.pow(1 + p.livingGrowth, year - p.startYear);

    // 投资投入（现金流出）、生育支出、父母赡养支出
    const investment = it.out;
    const child = childExpense(p, year);
    const parent = parentExpense(p, year);

    const income = wage + annuity + oneTime;
    const expense = housing + daily + investment + child + parent;
    return { wage, annuity, oneTime, housing, daily, investment, child, parent, income, expense };
  }

  function project(p) {
    p = p || buildPlan({});
    const endYear = p.startYear + (p.targetAge - p.currentAge);
    const rows = [];
    let prevEnd = 0;
    let firstNeg = null, worst = { year: null, age: null, value: Infinity };

    for (let year = p.startYear; year <= endYear; year++) {
      const age = p.currentAge + (year - p.startYear);
      const b0 = (year === p.startYear) ? p.startBalance : prevEnd;
      // 收益只作用于「正资产」：余额为负（阶段性缺口 / 尚在填坑）时不计投资回报，
      // 也避免「高收益反而让负值更深」导致乐观情景终点低于基准的情景错序。
      const ret = +(Math.max(b0, 0) * p.returnRate).toFixed(4);
      const f = yearFlows(p, year, age);
      const totalIncome = +(f.income + ret).toFixed(2); // 收入合计含理财收益
      const end = +(b0 + totalIncome - f.expense).toFixed(2);
      rows.push({
        year, age, b0: +b0.toFixed(2), ret,
        wage: f.wage, passive: +f.annuity.toFixed(2), oneTime: f.oneTime,
        income: totalIncome,
        housing: +f.housing.toFixed(2), daily: +f.daily.toFixed(2), investment: +f.investment.toFixed(2),
        child: +f.child.toFixed(2), parent: +f.parent.toFixed(2),
        expense: +f.expense.toFixed(2),
        end,
      });
      if (end < 0 && firstNeg === null) firstNeg = { year, age, value: end };
      if (end < worst.value) worst = { year, age, value: end };
      prevEnd = end;
    }

    const finalRow = rows[rows.length - 1];
    const metrics = {
      startYear: p.startYear,
      endYear,
      finalAge: finalRow.age,
      finalEnd: finalRow.end,
      firstNegative: firstNeg,
      worst,
      allPositive: firstNeg === null,
      gapAtTarget: finalRow.end < 0 ? -finalRow.end : 0,
    };
    return { plan: p, rows, metrics };
  }

  // 情景压力测试：同一计划下，乐观 / 悲观两种扰动对终点的抬升/压低
  function compare(p) {
    const base = project(p);
    const pessimistic = project(Object.assign({}, p, {
      returnRate: p.returnRate / 2,
      dailyAnnual: +(p.dailyAnnual * 1.15).toFixed(2),
    }));
    const optimistic = project(Object.assign({}, p, {
      returnRate: +(p.returnRate + 0.01).toFixed(4),
      dailyAnnual: +(p.dailyAnnual * 0.9).toFixed(2),
    }));
    return {
      base,
      pessimistic,
      optimistic,
      deltaPess: +(pessimistic.metrics.finalEnd - base.metrics.finalEnd).toFixed(2),
      deltaOpt:  +(optimistic.metrics.finalEnd  - base.metrics.finalEnd).toFixed(2),
    };
  }

  function formatWan(n) {
    const v = Math.round(n * 10) / 10;
    return (v > 0 ? '+' : '') + v + ' 万';
  }

  // 终点 → 财务安全维度打分（1–5），供决策矩阵预填
  function mapScore(end) {
    if (end >= 30) return 5;
    if (end >= 0) return 4;
    if (end >= -50) return 3;
    if (end >= -150) return 2;
    return 1;
  }

  const API = { DEFAULT_COMM_RATE, DEFAULT_GJJ_RATE, RENT_GROWTH, LIVING_GROWTH,
    DEFAULT_CHILD_STAGES, DEFAULT_PARENT_STAGES, DEFAULT_PARENT_STOP_AGE,
    monthlyMortgage, annualMortgage, ageFromDob,
    buildPlan, project, compare, formatWan, mapScore, parentExpense };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.FPEngine = API;
})(typeof window !== 'undefined' ? window : globalThis);
