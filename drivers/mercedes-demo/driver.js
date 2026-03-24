'use strict';

const Homey = require('homey');

class MercedesDemoDriver extends Homey.Driver {
  async onInit() {
    this.log('Mercedes Demo Driver has been initialized');
  }

  async onPair(session) {
    session.setHandler('list_devices', async () => {
      this.log('Listing demo vehicles');

      return [
        {
          name: 'Demo EQA (AB 1234)',
          data: {
            id: 'DEMO_VIN_EQA_00001',
            vin: 'DEMO_VIN_EQA_00001'
          },
          icon: '/drivers/mercedes-demo/assets/icon.svg',
          store: {
            model: 'EQA 250+',
            licensePlate: 'AB 1234',
            demo: true
          },
          settings: {
            vin: 'DEMO_VIN_EQA_00001',
            polling_interval: 0
          }
        },
        {
          name: 'Demo EQB (CD 5678)',
          data: {
            id: 'DEMO_VIN_EQB_00002',
            vin: 'DEMO_VIN_EQB_00002'
          },
          icon: '/drivers/mercedes-demo/assets/icon.svg',
          store: {
            model: 'EQB 350 4MATIC',
            licensePlate: 'CD 5678',
            demo: true
          },
          settings: {
            vin: 'DEMO_VIN_EQB_00002',
            polling_interval: 0
          }
        }
      ];
    });
  }
}

module.exports = MercedesDemoDriver;
