FROM node:10.24.0
ADD package.json .
RUN npm install
ADD lib lib
CMD ["node", "lib/index.js"]
