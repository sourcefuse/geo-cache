FROM node:10
ADD package.json .
RUN npm install
ADD lib lib
CMD ["node", "lib/index.js"]
