export class Metrics {
  #counters = new Map();
  #gauges = new Map();

  increment(name, labels = {}, amount = 1) {
    const key = metricKey(name, labels);
    const current = this.#counters.get(key) ?? { name, labels, value: 0 };
    current.value += amount;
    this.#counters.set(key, current);
  }

  gauge(name, value, labels = {}) {
    this.#gauges.set(metricKey(name, labels), { name, labels, value });
  }

  render() {
    return [...this.#counters.values(), ...this.#gauges.values()]
      .sort((a, b) => metricKey(a.name, a.labels).localeCompare(metricKey(b.name, b.labels)))
      .map(({ name, labels, value }) => `${sanitize(name)}${renderLabels(labels)} ${Number(value)}`)
      .join('\n') + '\n';
  }
}

function metricKey(name, labels) {
  return `${name}:${JSON.stringify(Object.entries(labels).sort())}`;
}

function sanitize(name) {
  return String(name).replace(/[^a-zA-Z0-9_:]/g, '_');
}

function renderLabels(labels) {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  return `{${entries.map(([key, value]) => `${sanitize(key)}="${String(value).replace(/["\\\n]/g, '\\$&')}"`).join(',')}}`;
}
