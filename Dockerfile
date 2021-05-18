FROM node:10.23.1
ADD package.json .
RUN npm install
ADD lib lib
CMD ["node", "lib/index.js"]
