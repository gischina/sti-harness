/**
 * 零依赖声明式入参校验器。
 *
 * 为什么存在：路由层此前对请求体的"校验"散落在各 service 深处的零散 throw ——
 * "username 传了个数组"这种最浅的错误会一路穿到 scrypt / SQL 层才炸，
 * 文案不稳定、位置难定位，审计里也只剩一句"内部错误"。
 * 形状校验就该发生在**最浅的一层**，用一份**声明**完成，且一次报全。
 *
 * 只做四件事：type / required / enum / maxLen。
 * 刻意不做：类型转换（"5" → 5 是在猜用户意图）、默认值注入（静默改写入参）、
 * 嵌套 schema（要校验深层结构说明接口设计该反思了）——
 * 校验器长成框架的那一天，就是它开始被绕过的那一天。
 *
 * 语义约定：
 *   · `undefined / null / ''` 一律视为"未填"——只有 required 才报错，
 *     否则跳过其余检查（可选字段传空串与不传等价，调用方不必为"清空字段"发明特殊值）；
 *   · 校验不通过时**一次报全**所有字段的问题（让调用方逐字段试错太折磨人）；
 *   · 只认形状，不认语义（"用户名是否已存在"是 service 的事）。
 *
 * Copyright 2026 liwei（易智瑞西安）.
 */

/** 类型谓词表 —— 每种 type 一行，别处不许再手写 typeof 判断 */
const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  stringArray: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
};

const TYPE_NAMES = {
  string: '字符串',
  number: '数字',
  boolean: '布尔值',
  array: '数组',
  stringArray: '字符串数组',
  object: '对象',
};

/**
 * 校验请求体。
 * @param {Record<string, {type?:string, required?:boolean, enum?:string[], maxLen?:number, label?:string}>} schema
 * @param {unknown} body 已解析的 JSON 请求体
 * @returns {{ok:true}|{ok:false, errors:Array<{field:string, message:string}>}}
 */
export function validateBody(schema, body) {
  const errors = [];
  const isObject = body !== null && typeof body === 'object' && !Array.isArray(body);
  if (!isObject) {
    // 整个 body 都不是对象（数组 / 标量 / 空缺）：required 字段必然没满足
    for (const [field, rule] of Object.entries(schema || {})) {
      if (rule && rule.required) errors.push({ field, message: '缺少必填字段' });
    }
    if (!errors.length) errors.push({ field: '(body)', message: '请求体必须是 JSON 对象' });
    return { ok: false, errors };
  }
  for (const [field, rule] of Object.entries(schema || {})) {
    if (!rule) continue;
    const v = body[field];
    const empty = v === undefined || v === null || v === '';
    if (empty) {
      if (rule.required) errors.push({ field, message: '缺少必填字段' });
      continue; // 未填的可选字段不做后续检查
    }
    const label = typeof rule.label === 'string' && rule.label ? rule.label : field;
    const typeName = rule.type || 'string';
    const check = TYPE_CHECKS[typeName];
    if (!check || !check(v)) {
      errors.push({ field, message: label + ' 必须是' + (TYPE_NAMES[typeName] || '合法类型') });
      continue; // 类型都不对，长度 / 枚举没有意义
    }
    if (rule.maxLen && v.length > rule.maxLen) {
      errors.push({ field, message: label + ' 长度不能超过 ' + rule.maxLen + ' 个字符' });
    }
    if (Array.isArray(rule.enum) && rule.enum.length) {
      const bad = typeName === 'stringArray'
        ? v.some((x) => !rule.enum.includes(x))
        : !rule.enum.includes(v);
      if (bad) errors.push({ field, message: label + ' 只允许：' + rule.enum.join(' / ') });
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
