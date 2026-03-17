const fs = require('fs/promises');
const path = require('path');

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

class JsonFileStore {
  constructor(filePath, defaultValue) {
    this.filePath = filePath;
    this.defaultValue = cloneValue(defaultValue);
    this.writeQueue = Promise.resolve();
  }

  async ensure() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      await fs.access(this.filePath);
    } catch (error) {
      await fs.writeFile(this.filePath, JSON.stringify(this.defaultValue, null, 2));
    }
  }

  async read() {
    await this.ensure();

    const rawContent = await fs.readFile(this.filePath, 'utf8');

    if (!rawContent.trim()) {
      return cloneValue(this.defaultValue);
    }

    try {
      return JSON.parse(rawContent);
    } catch (error) {
      throw new Error(`Invalid JSON in ${this.filePath}: ${error.message}`);
    }
  }

  async write(value) {
    this.writeQueue = this.writeQueue.then(() =>
      fs.writeFile(this.filePath, JSON.stringify(value, null, 2)),
    );

    return this.writeQueue;
  }
}

module.exports = {
  JsonFileStore,
};
